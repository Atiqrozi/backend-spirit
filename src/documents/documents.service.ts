import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import { ImageKitService } from '../files/imagekit.service';
import { VectorStoreService } from '../vector-store/vector-store.service';
import { TextChunkerService } from './text-chunker.service';

@Injectable()
export class DocumentProcessingService {
  constructor(
    @InjectModel('ReferenceDocument') private readonly documents: Model<any>,
    @InjectModel('DocumentVersion') private readonly versions: Model<any>,
    @InjectModel('DocumentPage') private readonly pages: Model<any>,
    @InjectQueue('document-extraction') private readonly queue: Queue,
    private readonly files: ImageKitService,
    private readonly chunker: TextChunkerService,
    private readonly vectorStore: VectorStoreService,
  ) {}

  async list(query: any) {
    const filter: any = {};
    if (query.status) filter.status = query.status;
    if (query.category) filter['data.category'] = query.category;
    if (query.search) filter['data.title'] = { $regex: query.search, $options: 'i' };
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
    const [items, total] = await Promise.all([
      this.documents.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.documents.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  create(dto: any, user: any) { return this.documents.create({ data: dto, createdBy: user.sub, status: 'DRAFT' }); }

  async addVersion(id: string, file: Express.Multer.File, dto: any, user: any) {
    const parent = await this.documents.findById(id);
    if (!parent) throw new NotFoundException('Dokumen acuan tidak ditemukan');
    const versionId = new Types.ObjectId();
    let upload: any;
    try {
      upload = await this.files.upload(file.buffer, file.originalname, `/spi/reference-documents/${id}/${versionId}`, true);
      const version = await this.versions.create({ _id: versionId, documentId: id, version: Number(parent.version || 0) + 1, createdBy: user.sub, status: 'PROCESSING', data: {
        ...dto, file: { provider: 'imagekit', fileId: upload.fileId, filePath: upload.filePath, url: upload.url, fileName: upload.name, mimeType: file.mimetype, sizeBytes: file.size, uploadedBy: user.sub, uploadedAt: new Date(), status: 'UPLOADED' },
      } });
      parent.version = version.version;
      await parent.save();
      await this.queue.add('extract', { entityType: 'REFERENCE_DOCUMENT', documentId: id, versionId: String(version._id) }, {
        jobId: `reference-extract-${version._id}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 100, removeOnFail: 500,
      });
      return version;
    } catch (error) {
      if (upload?.fileId) await this.files.delete(upload.fileId).catch(() => undefined);
      throw error;
    }
  }

  async publish(id: string, userId: string) {
    const document = await this.documents.findById(id);
    if (!document) throw new NotFoundException('Dokumen acuan tidak ditemukan');
    const version: any = await this.versions.findOne({ documentId: id }).sort({ version: -1, createdAt: -1 }).lean();
    if (!version) throw new ConflictException('Unggah versi dokumen sebelum mengaktifkan dokumen acuan');
    if (!['READY_FOR_REVIEW', 'NEEDS_MANUAL_REVIEW', 'ACTIVE'].includes(version.status)) throw new ConflictException('Pemrosesan versi dokumen belum selesai');
    const versionId = String(version._id);
    const pageRows = await this.pages.find({ documentVersionId: versionId }).sort({ pageNumber: 1 }).select('pageNumber text status').lean();
    const chunks = this.chunker.createChunks(id, versionId, pageRows.map((page: any) => ({ pageNumber: page.pageNumber, text: page.text || '', status: page.status })));
    if (!chunks.chunks.length) throw new ConflictException('Tidak ada teks yang dapat di-index dari versi dokumen');
    const indexed = await this.vectorStore.countVersionChunks(id, versionId);
    if (!indexed) await this.vectorStore.indexChunks(chunks, userId, 'DRAFT');
    await this.vectorStore.archiveOtherVersions(id, versionId);
    await this.vectorStore.setVersionStatus(versionId, 'ACTIVE');
    await this.versions.updateMany({ documentId: id, _id: { $ne: version._id }, status: { $ne: 'FAILED' } }, { $set: { status: 'ARCHIVED' } });
    await this.versions.updateOne({ _id: version._id }, { $set: { status: 'ACTIVE', 'data.publishedAt': new Date(), 'data.publishedBy': userId } });
    document.status = 'ACTIVE';
    await document.save();
    return { documentId: id, documentVersionId: versionId, status: 'ACTIVE', indexedCount: chunks.chunks.length };
  }

  async reprocess(id: string) {
    const version: any = await this.versions.findOne({ documentId: id }).sort({ version: -1, createdAt: -1 }).lean();
    if (!version) throw new NotFoundException('Versi dokumen belum tersedia');
    const filePath = version.data?.file?.filePath;
    if (!filePath && !version.data?.file?.url) throw new ConflictException('File versi dokumen tidak tersedia');
    await this.versions.updateOne({ _id: version._id }, { $set: { status: 'PROCESSING' } });
    const job = await this.queue.add('extract', { entityType: 'REFERENCE_DOCUMENT', documentId: id, versionId: String(version._id) }, {
      jobId: `reference-reprocess-${version._id}-${Date.now()}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 100, removeOnFail: 500,
    });
    return { accepted: true, documentId: id, documentVersionId: String(version._id), jobId: job.id };
  }

  async listVersions(id: string) {
    if (!await this.documents.exists({ _id: id })) throw new NotFoundException('Dokumen acuan tidak ditemukan');
    return this.versions.find({ documentId: id })
      .sort({ version: -1, createdAt: -1 })
      .select('documentId version status data.file.fileId data.file.fileName data.file.mimeType data.file.sizeBytes data.processing createdAt')
      .lean();
  }

  status(id: string) { return this.versions.find({ documentId: id }).sort({ createdAt: -1 }).select('status data.file data.processing createdAt version').lean(); }
}
