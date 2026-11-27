import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Model, Types } from 'mongoose';
import { NvidiaService } from '../integrations/nvidia/nvidia.service';
import { VectorStoreService } from '../vector-store/vector-store.service';
import { normalizeComplianceStatus, validateReportEvidence } from './evaluation.rules';

interface ReportEvidence { pageNumber?: number; quote?: string; }
interface ReviewFinding { title?: string; description?: string; priority?: string; suggestion?: string; reasoning?: string; confidence?: number | null; complianceStatus?: string; sourceChunkIds?: string[]; reportEvidence?: ReportEvidence[]; }
interface AiRecommendation extends ReviewFinding { rationale?: string; action?: string; needsVerification?: boolean; }
interface AiReview { summary?: string; limitations?: string[]; regulationAssessments?: Array<{ documentId?: string; documentVersionId?: string; status?: string; summary?: string; sourceChunkIds?: string[] }>; findings?: ReviewFinding[]; reportRecommendations?: AiRecommendation[]; inspectionRecommendations?: AiRecommendation[]; }

@Injectable()
@Processor('report-review', { concurrency: 2 })
export class ReportReviewProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportReviewProcessor.name);
  constructor(
    @InjectModel('Report') private readonly reports: Model<any>,
    @InjectModel('ReportVersion') private readonly reportVersions: Model<any>,
    @InjectModel('ReportTemplateVersion') private readonly templateVersions: Model<any>,
    @InjectModel('Review') private readonly reviews: Model<any>,
    @InjectModel('ReviewFinding') private readonly findings: Model<any>,
    @InjectModel('ReviewSource') private readonly sourcesModel: Model<any>,
    @InjectModel('DocumentPage') private readonly pages: Model<any>,
    @InjectModel('Recommendation') private readonly recommendations: Model<any>,
    private readonly nvidia: NvidiaService,
    private readonly vectorStore: VectorStoreService,
  ) { super(); }

  async process(job: Job<{ reportId: string; userId: string; reportVersionId?: string; reviewId?: string; memoId?: string; reviewPurpose?: string }>) {
    const { reportId, userId } = job.data;
    await this.reports.updateOne({ _id: reportId }, { $set: { status: 'UNDER_REVIEW' } });
    try {
      const report: any = await this.reports.findById(reportId).lean();
      if (!report) throw new Error('Laporan tidak ditemukan');
      const reportIdValues: any[] = [reportId, ...(Types.ObjectId.isValid(reportId) ? [new Types.ObjectId(reportId)] : [])];
      const version: any = job.data.reportVersionId
        ? await this.reportVersions.findOne({ _id: job.data.reportVersionId, reportId: { $in: reportIdValues } }).lean()
        : await this.reportVersions.findOne({ reportId: { $in: reportIdValues } }).sort({ version: -1, createdAt: -1 }).lean();
      if (!version) throw new Error(`Versi laporan ${job.data.reportVersionId || '(terbaru)'} tidak ditemukan untuk laporan ${reportId}`);
      const reviewPurpose = version?.data?.reviewPurpose || job.data.reviewPurpose || 'REPORT_REVIEW';
      const isDispositionReview = reviewPurpose === 'DIRECTOR_DISPOSITION';
      const dispositionText = await this.getReportText(report, version);
      const originalVersion: any = isDispositionReview
        ? await this.reportVersions.findOne({ reportId: { $in: reportIdValues }, _id: { $ne: version._id }, 'data.documentRole': { $ne: 'DIRECTOR_DISPOSITION' } }).sort({ version: -1, createdAt: -1 }).lean()
        : null;
      const originalReportText = originalVersion ? await this.getReportText(report, originalVersion) : '';
      const priorReview: any = isDispositionReview && version.data?.baseReviewId
        ? await this.reviews.findOne({ _id: version.data.baseReviewId, reportId }).lean()
        : null;
      const previousReviewContext = priorReview ? {
        summary: String(priorReview.data?.summary || '').slice(0, isDispositionReview ? 2500 : 8000),
        findings: (await this.findings.find({ reviewId: priorReview._id }).select('title description complianceStatus suggestion priority').limit(isDispositionReview ? 5 : 50).lean()).map((item: any) => ({ ...item, description: String(item.description || '').slice(0, isDispositionReview ? 350 : 700), suggestion: String(item.suggestion || '').slice(0, isDispositionReview ? 250 : 500) })),
        recommendations: (await this.recommendations.find({ reviewId: priorReview._id }).select('title description action rationale priority status').limit(isDispositionReview ? 5 : 50).lean()).map((item: any) => ({ ...item, description: String(item.description || '').slice(0, isDispositionReview ? 350 : 700), action: String(item.action || '').slice(0, isDispositionReview ? 250 : 500), rationale: String(item.rationale || '').slice(0, isDispositionReview ? 250 : 500) })),
      } : null;
      const reportText = dispositionText;
      if (!reportText.trim()) throw new Error('Teks hasil ekstraksi laporan belum tersedia');
      if (isDispositionReview && !originalReportText) throw new Error('Teks laporan awal tidak tersedia untuk dikaitkan dengan disposisi');

      const templateVersionId = report.data?.templateVersionId || version?.data?.templateVersionId;
      const template: any = templateVersionId ? await this.templateVersions.findById(templateVersionId).lean() : null;
      // Put the director's actual instruction first; slicing a concatenated report from
      // the front used to drop the disposition whenever the original report was long.
      const retrievalQuery = (isDispositionReview
        ? `${report.data?.title || ''}\nARAHAN DISPOSISI DIREKTUR:\n${dispositionText.slice(0, 5000)}\nTEMUAN LAPORAN AWAL:\n${previousReviewContext?.summary || originalReportText.slice(0, 1500)}`
        : `${report.data?.title || ''}\n${reportText}`).trim().slice(0, 7500);
      const dispositionTimeoutMs = Math.max(Number(process.env.NVIDIA_DISPOSITION_REVIEW_TIMEOUT_MS || 240000), 10000);
      const retrieval = await this.vectorStore.search({ query: retrievalQuery, topK: isDispositionReview ? 16 : 30, rerank: true, rerankTopN: isDispositionReview ? 8 : 20, ...(isDispositionReview ? { timeoutMs: dispositionTimeoutMs } : {}) });
      const sources = retrieval.sources.slice(0, isDispositionReview ? 6 : 20).map((source: any) => ({
        chunkId: source.chunkId, documentId: source.documentId, documentVersionId: source.documentVersionId,
        pageStart: source.pageStart, pageEnd: source.pageEnd, section: source.section,
        text: String(source.text || '').slice(0, isDispositionReview ? 1000 : 4000),
      }));

      const reportPages = version?._id ? await this.pages.find({ documentVersionId: String(version._id) }).sort({ pageNumber: 1 }).select('pageNumber text').lean() : [];
      // Bound repeated page text to avoid sending the same large report twice to the chat model.
      const maxEvidencePages = Math.max(1, Math.min(Number(process.env.MAX_REVIEW_EVIDENCE_PAGES || 40), isDispositionReview ? 4 : 40));
      const pageStride = Math.max(1, Math.ceil(reportPages.length / maxEvidencePages));
      const boundedPages = reportPages.filter((_: any, index: number) => index % pageStride === 0 || index === reportPages.length - 1)
        .slice(0, maxEvidencePages).map((page: any) => ({ pageNumber: page.pageNumber, text: String(page.text || '').slice(0, isDispositionReview ? 900 : 4000) }));
      const maxReviewText = Number(process.env.MAX_REVIEW_TEXT_CHARS || 50000);
      const reviewInput = isDispositionReview
        ? JSON.stringify({
          originalReport: originalReportText.slice(0, Math.min(maxReviewText, 7000)),
          directorDisposition: dispositionText.slice(0, Math.min(maxReviewText, 10000)),
          dispositionPages: boundedPages,
          previousAiReview: previousReviewContext,
        })
        : JSON.stringify({ text: reportText.slice(0, maxReviewText), pages: boundedPages, previousAiReview: previousReviewContext });
      const aiResponse = await this.nvidia.review(reviewInput, template?.data || null, sources, reviewPurpose) as any;
      const reviewData = this.parseReview(aiResponse?.choices?.[0]?.message?.content);
      const sourceMap = new Map(sources.map((source: any) => [source.chunkId, source]));
      const sourceDocumentVersions = new Map<string, any[]>();
      for (const source of sources as any[]) {
        const key = `${source.documentId}:${source.documentVersionId}`;
        sourceDocumentVersions.set(key, [...(sourceDocumentVersions.get(key) || []), source]);
      }
      const allowedCompliance = new Set(['COMPLIANT', 'NON_COMPLIANT', 'PARTIALLY_COMPLIANT', 'NOT_ASSESSABLE']);
      const regulationAssessments = (reviewData.regulationAssessments || []).flatMap((assessment) => {
        const key = `${assessment.documentId}:${assessment.documentVersionId}`;
        const docSources: any[] = sourceDocumentVersions.get(key) || [];
        if (!docSources.length) return [];
        const allowedIds = new Set(docSources.map((source) => source.chunkId));
        const ids = [...new Set((assessment.sourceChunkIds || []).filter((chunkId) => allowedIds.has(chunkId)))];
        return [{ documentId: assessment.documentId, documentVersionId: assessment.documentVersionId,
          status: allowedCompliance.has(String(assessment.status).toUpperCase()) ? String(assessment.status).toUpperCase() : 'NOT_ASSESSABLE',
          summary: String(assessment.summary || '').slice(0, 4000), sourceChunkIds: ids }];
      });
      const review = await this.reviews.findOneAndUpdate(
        job.data.reviewId ? { _id: job.data.reviewId, jobId: String(job.id) } : { jobId: String(job.id) },
        { $set: { reportId, reportVersionId: version._id, templateVersionId, reviewerId: userId, jobId: String(job.id), status: 'PROCESSING', data: {
          summary: String(reviewData.summary || '').slice(0, 12000), model: process.env.CHAT_AI_MODEL || process.env.NVIDIA_CHAT_MODEL,
          embeddingModel: retrieval.embeddingModel, rerankModel: retrieval.rerankModel, sourceCount: sources.length,
          limitations: (reviewData.limitations || []).filter((item) => typeof item === 'string').slice(0, 50).map((item) => item.slice(0, 2000)),
          regulationAssessments,
          memoId: job.data.memoId || version.data?.memoId || null,
          reviewPurpose,
          status: 'AI_REVIEW_PROCESSING', humanVerificationStatus: 'PENDING', invalidSourceReferencesDropped: false,
        } } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      await this.findings.deleteMany({ reviewId: review._id });
      await this.sourcesModel.deleteMany({ reviewId: review._id });
      await this.recommendations.deleteMany({ reviewId: review._id, status: { $in: ['PENDING_REVIEW', 'NEEDS_VERIFICATION'] } });
      const allowedPriorities = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
      const pageText = new Map<number, string>(boundedPages.map((page: any) => [Number(page.pageNumber), String(page.text)]));
      const validEvidence = (items: ReportEvidence[] = []) => validateReportEvidence(items, pageText);
      const normalizedFindings = (reviewData.findings || []).filter((finding) => finding && typeof finding === 'object').slice(0, 100).map((finding) => {
        const requestedIds = Array.isArray(finding.sourceChunkIds) ? finding.sourceChunkIds : [];
        const validIds = [...new Set(requestedIds.filter((id) => typeof id === 'string' && sourceMap.has(id)))];
        return {
          reviewId: review._id, reportId, title: String(finding.title || 'Temuan').slice(0, 500),
          description: String(finding.description || '').slice(0, 8000),
          priority: allowedPriorities.has(String(finding.priority).toUpperCase()) ? String(finding.priority).toUpperCase() : 'MEDIUM',
          suggestion: String(finding.suggestion || '').slice(0, 4000),
          reasoning: String(finding.reasoning || '').slice(0, 4000),
          complianceStatus: normalizeComplianceStatus(finding.complianceStatus),
          confidence: typeof finding.confidence === 'number' && finding.confidence >= 0 && finding.confidence <= 1 ? finding.confidence : null,
          reportEvidence: validEvidence(finding.reportEvidence),
          sourceChunkIds: validIds,
          sourceVerification: validIds.length ? 'VERIFIED_RETRIEVED_SOURCE' : 'NO_VERIFIABLE_SOURCE',
          invalidSourceReferencesDropped: requestedIds.some((id) => typeof id !== 'string' || !sourceMap.has(id)),
        };
      });
      const invalidReferencesDropped = normalizedFindings.some((finding) => finding.invalidSourceReferencesDropped);
      if (normalizedFindings.length) {
        const savedFindings = await this.findings.insertMany(normalizedFindings);
        const sourceRows = savedFindings.flatMap((finding: any, index: number) => normalizedFindings[index].sourceChunkIds.map((chunkId) => {
          const source: any = sourceMap.get(chunkId);
          return { reviewId: review._id, findingId: finding._id, chunkId, documentId: source.documentId,
            documentVersionId: source.documentVersionId, pageStart: source.pageStart, pageEnd: source.pageEnd,
            section: source.section, text: source.text };
        }));
        if (sourceRows.length) await this.sourcesModel.insertMany(sourceRows);
      }
      const normalizedRecommendations = [
        ...(reviewData.reportRecommendations || []).slice(0, 100).map((item) => ({ item, type: 'REPORT_IMPROVEMENT' as const })),
        ...(reviewData.inspectionRecommendations || []).slice(0, 100).map((item) => ({ item, type: 'INSPECTION_IMPROVEMENT' as const })),
      ].map(({ item, type }) => {
        const ids = [...new Set((Array.isArray(item.sourceChunkIds) ? item.sourceChunkIds : []).filter((id) => typeof id === 'string' && sourceMap.has(id)))];
        return {
          reportId, reportVersionId: version._id, reviewId: review._id, type,
          title: String(item.title || 'Rekomendasi').slice(0, 500), description: String(item.description || '').slice(0, 8000),
          rationale: String(item.rationale || item.reasoning || '').slice(0, 4000), action: String(item.action || item.suggestion || '').slice(0, 4000),
          priority: allowedPriorities.has(String(item.priority).toUpperCase()) ? String(item.priority).toUpperCase() : 'MEDIUM',
          status: item.needsVerification ? 'NEEDS_VERIFICATION' : 'PENDING_REVIEW',
          verificationStatus: item.needsVerification ? 'NEEDS_VERIFICATION' : 'SUPPORTED',
          sourceChunkIds: ids,
          reportEvidence: validEvidence(item.reportEvidence),
          regulationSources: ids.map((id) => sourceMap.get(id)),
        };
      });
      if (normalizedRecommendations.length) await this.recommendations.insertMany(normalizedRecommendations);
      await this.reviews.updateOne({ _id: review._id }, { $set: {
        status: 'COMPLETED', 'data.status': 'AI_REVIEW_COMPLETED', 'data.completedAt': new Date(),
        'data.invalidSourceReferencesDropped': invalidReferencesDropped,
      } });
      await this.reports.updateOne({ _id: reportId }, { $set: { status: 'UNDER_REVIEW', latestReviewId: review._id } });
      return { reportId, reviewId: review._id, findingCount: normalizedFindings.length, sourceCount: sources.length };
    } catch (error) {
      this.logger.error(`Review job ${job.id} gagal: ${this.safeError(error)}`);
      const isDispositionReview = job.data.reviewPurpose === 'DIRECTOR_DISPOSITION';
      const attempts = isDispositionReview ? 1 : Number(job.opts.attempts || 1);
      if (job.attemptsMade + 1 >= attempts) {
        if (!isDispositionReview) await this.reports.updateOne({ _id: reportId }, { $set: { status: 'FAILED' } });
        if (job.data.reviewId) await this.reviews.updateOne({ _id: job.data.reviewId }, { $set: {
          status: 'FAILED', 'data.status': 'FAILED', 'data.failedAt': new Date(), 'data.failureReason': this.safeError(error),
        } });
      }
      if (isDispositionReview) await job.discard();
      throw error;
    }
  }

  private async getReportText(report: any, version: any): Promise<string> {
    const candidates = [version?.data?.extractedText, version?.data?.text, report?.data?.extractedText, report?.data?.text];
    const direct = candidates.find((value) => typeof value === 'string' && value.trim());
    if (direct) return direct.trim();
    if (version?._id) {
      const pageRows = await this.pages.find({ documentVersionId: String(version._id) }).sort({ pageNumber: 1 }).select('text').lean();
      return pageRows.map((row: any) => row.text || '').filter(Boolean).join('\n\n').trim();
    }
    return '';
  }

  private parseReview(content: unknown): AiReview {
    if (typeof content !== 'string') throw new BadGatewayException('Respons review AI tidak berisi teks JSON');
    const json = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string' || !Array.isArray(parsed.findings)) throw new Error('schema');
      return parsed;
    } catch { throw new BadGatewayException('Respons review AI bukan JSON sesuai schema'); }
  }

  private safeError(error: unknown) { return error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[external-url]').slice(0, 300) : 'Review AI gagal'; }
}
