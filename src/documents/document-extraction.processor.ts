import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import pdfParse = require('pdf-parse');
import { NvidiaService } from '../integrations/nvidia/nvidia.service';
import { VectorStoreService } from '../vector-store/vector-store.service';
import { ImageKitService } from '../files/imagekit.service';
import { TextChunkerService, ExtractedPage } from './text-chunker.service';

interface OcrResponse { data?: Array<{ index: number; text_detections?: Array<{ text_prediction?: { text?: string; confidence?: number } }> }>; }

// Keep native import out of the deployment bundler's static analysis: pdf-raster is ESM-only,
// while the Vercel NestJS function is emitted as CommonJS.
const importEsmAtRuntime = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

@Injectable()
@Processor('document-extraction', { concurrency: 2 })
export class DocumentExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentExtractionProcessor.name);
  constructor(
    @InjectModel('DocumentVersion') private readonly versions: Model<any>,
    @InjectModel('ReportVersion') private readonly reportVersions: Model<any>,
    @InjectModel('Report') private readonly reports: Model<any>,
    @InjectModel('ReferenceDocument') private readonly referenceDocuments: Model<any>,
    @InjectModel('DocumentPage') private readonly pagesModel: Model<any>,
    private readonly nvidia: NvidiaService,
    private readonly files: ImageKitService,
    private readonly chunker: TextChunkerService,
    private readonly vectorStore: VectorStoreService,
  ) { super(); }

  async process(job: Job<{ documentId: string; versionId: string; url?: string; entityType?: 'REFERENCE_DOCUMENT' | 'REPORT' }>) {
    const { documentId, versionId } = job.data;
    const isReport = job.data.entityType === 'REPORT';
    const versionModel = isReport ? this.reportVersions : this.versions;
    await versionModel.updateOne({ _id: versionId }, { $set: { status: 'PROCESSING' } });
    try {
      const version: any = await versionModel.findById(versionId).lean();
      if (!version) throw new Error('Versi dokumen tidak ditemukan');
      if (!isReport && !await this.referenceDocuments.exists({ _id: documentId })) throw new Error('Dokumen acuan tidak ditemukan');
      const sourceUrl = version.data?.file?.filePath
        ? this.files.createSignedUrl(version.data.file.filePath, 900)
        : (job.data.url || version.data?.file?.url);
      if (!sourceUrl) throw new Error('URL file dokumen tidak tersedia');
      const download = await fetch(sourceUrl, { signal: AbortSignal.timeout(60000) });
      if (!download.ok) throw new Error(`File ImageKit gagal diunduh (${download.status})`);
      const fileBuffer = Buffer.from(await download.arrayBuffer());
      const mimeType = version.data?.file?.mimeType || download.headers.get('content-type') || 'application/pdf';
      let extractedPages: ExtractedPage[];
      if (mimeType === 'application/pdf' || sourceUrl.toLowerCase().split('?')[0].endsWith('.pdf')) {
        extractedPages = await this.extractPdf(fileBuffer);
      } else if (mimeType.startsWith('image/')) {
        const page = await this.runOcr(fileBuffer, mimeType);
        extractedPages = [{ pageNumber: 1, text: page.text, status: page.text ? 'OCR_COMPLETED' : 'NEEDS_MANUAL_REVIEW' }];
      } else {
        throw new Error(`Format worker tidak didukung: ${mimeType}`);
      }

      await this.persistPages(versionId, extractedPages);
      const { chunks } = this.chunker.createChunks(documentId, versionId, extractedPages);
      let indexedCount = 0;
      const manualReviewPages = extractedPages.filter((page) => page.status === 'NEEDS_MANUAL_REVIEW' || page.status === 'OCR_FAILED').map((page) => page.pageNumber);
      const vectorStatus = version.data?.publishedAt && !manualReviewPages.length ? 'ACTIVE' : 'DRAFT';
      if (!isReport && chunks.length) {
        const indexed = await this.vectorStore.indexChunks({ documentId, documentVersionId: versionId, chunks }, version.createdBy || 'system', vectorStatus);
        indexedCount = indexed.indexedCount;
      }
      if (!isReport) {
        await this.vectorStore.removeObsoleteVersionChunks(versionId, chunks.map((chunk) => chunk.chunkId));
        await this.vectorStore.setVersionStatus(versionId, chunks.length ? vectorStatus : 'DRAFT');
      }
      const finalStatus = manualReviewPages.length ? 'NEEDS_MANUAL_REVIEW' : (isReport ? 'EXTRACTED' : (chunks.length ? (vectorStatus === 'ACTIVE' ? 'ACTIVE' : 'READY_FOR_REVIEW') : 'NEEDS_MANUAL_REVIEW'));
      await versionModel.updateOne({ _id: versionId }, { $set: {
        status: finalStatus,
        'data.processing': { status: finalStatus, pageCount: extractedPages.length, chunkCount: chunks.length, indexedCount, manualReviewPages, processedAt: new Date() },
      } });
      if (isReport) {
        await this.reports.updateOne({ _id: documentId }, { $set: { status: 'UPLOADED', 'data.extractionStatus': finalStatus } });
      } else {
        const processedAt = new Date();
        await this.referenceDocuments.updateOne(
          { _id: documentId, version: version.version },
          { $set: {
            'data.latestVersionId': versionId,
            'data.ocrStatus': finalStatus,
            'data.ocrSummary': {
              pageCount: extractedPages.length,
              chunkCount: chunks.length,
              indexedCount,
              manualReviewPages,
              processedAt,
            },
            updatedAt: processedAt,
          } },
        );
      }
      return { documentId, versionId, pageCount: extractedPages.length, chunkCount: chunks.length, indexedCount, manualReviewPages };
    } catch (error) {
      const attempts = Number(job.opts.attempts || 1);
      if (job.attemptsMade + 1 >= attempts) {
        await versionModel.updateOne({ _id: versionId }, { $set: { status: 'FAILED', 'data.processing': { status: 'FAILED', error: this.safeError(error), failedAt: new Date() } } });
        if (isReport) await this.reports.updateOne({ _id: documentId }, { $set: { status: 'FAILED', 'data.extractionStatus': 'FAILED' } });
      }
      throw error;
    }
  }

  private async extractPdf(buffer: Buffer): Promise<ExtractedPage[]> {
    const nativeText: string[] = [];
    const parsed = await pdfParse(buffer, { pagerender: async (page: any) => {
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => typeof item.str === 'string' ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
      nativeText.push(text);
      return text;
    } });
    const pageCount = Number(parsed.numpages || nativeText.length);
    const maxPages = Number(process.env.MAX_PDF_PAGES || 500);
    if (!pageCount || pageCount > maxPages) throw new Error(`Jumlah halaman PDF tidak valid atau melebihi batas ${maxPages}`);
    const pages: ExtractedPage[] = Array.from({ length: pageCount }, (_, index) => ({ pageNumber: index + 1, text: nativeText[index] || '', status: (nativeText[index] || '').length >= 20 ? 'NATIVE_TEXT_EXTRACTED' : 'PENDING_OCR' }));
    const scanIndices = pages.filter((page) => page.status === 'PENDING_OCR').map((page) => page.pageNumber - 1);
    const { convert } = scanIndices.length ? await importEsmAtRuntime('pdf-raster') : { convert: null };
    for (const pageIndex of scanIndices) {
      const page = pages[pageIndex];
      let completed = false;
      for (const dpi of [140, 110, 85]) {
        const [renderedPage] = await convert(buffer, { pages: [pageIndex], dpi, outputFormat: 'jpeg', maxPixels: 5_000_000 });
        try {
          const ocr = await this.runOcr(renderedPage.data, renderedPage.mimeType);
          page.text = ocr.text;
          page.status = ocr.text ? 'OCR_COMPLETED' : 'NEEDS_MANUAL_REVIEW';
          completed = true;
          break;
        } catch (error) {
          if (!(error instanceof OcrImageTooLargeError)) throw error;
        }
      }
      if (!completed) {
        page.status = 'NEEDS_MANUAL_REVIEW';
        this.logger.warn(`OCR dilewati untuk halaman ${page.pageNumber}: gambar melewati batas API`);
      }
    }
    return pages;
  }

  private async runOcr(image: Buffer, mimeType: string) {
    const maxRawBytes = Number(process.env.NVIDIA_OCR_MAX_IMAGE_BYTES || 130000);
    if (image.byteLength > maxRawBytes) throw new OcrImageTooLargeError();
    const dataUrl = `data:${mimeType};base64,${image.toString('base64')}`;
    const response = await this.nvidia.ocr(dataUrl) as OcrResponse;
    const text = (response.data?.[0]?.text_detections || []).map((detection) => detection.text_prediction?.text || '').filter(Boolean).join('\n').trim();
    return { text };
  }

  private async persistPages(versionId: string, pages: ExtractedPage[]) {
    const ops = pages.map((page) => ({ updateOne: {
      filter: { documentVersionId: versionId, pageNumber: page.pageNumber },
      update: { $set: { documentVersionId: versionId, pageNumber: page.pageNumber, text: page.text, status: page.status, extractedAt: new Date() } },
      upsert: true,
    } }));
    if (ops.length) await this.pagesModel.bulkWrite(ops, { ordered: true });
    await this.pagesModel.deleteMany({ documentVersionId: versionId, pageNumber: { $gt: pages.length } });
  }

  private safeError(error: unknown) {
    if (error instanceof Error) return error.message.replace(/https?:\/\/\S+/g, '[external-url]').slice(0, 300);
    return 'Pemrosesan dokumen gagal';
  }
}

class OcrImageTooLargeError extends Error {}
