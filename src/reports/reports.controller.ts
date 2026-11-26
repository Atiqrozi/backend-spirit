import { Body, Controller, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';
import { ImageKitService } from '../files/imagekit.service';

class ReportDto { @IsString() title: string; @IsOptional() @IsString() type?: string; @IsOptional() @IsString() unit?: string; @IsOptional() @IsString() templateVersionId?: string; }
class FindingReviewDto { @IsOptional() @IsIn(['COMPLIANT', 'NON_COMPLIANT', 'PARTIALLY_COMPLIANT', 'NOT_ASSESSABLE']) complianceStatus?: string; @IsOptional() @IsString() @MaxLength(4000) reviewerNote?: string; }

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(
    @InjectModel('Report') private readonly reports: Model<any>,
    @InjectModel('ReportVersion') private readonly versions: Model<any>,
    @InjectModel('Approval') private readonly approvals: Model<any>,
    @InjectModel('Review') private readonly reviews: Model<any>,
    @InjectModel('ReviewFinding') private readonly findings: Model<any>,
    @InjectModel('ReviewSource') private readonly reviewSources: Model<any>,
    @InjectModel('Recommendation') private readonly recommendations: Model<any>,
    @InjectModel('EvaluationHistory') private readonly evaluationHistory: Model<any>,
    @InjectQueue('report-review') private readonly reviewQueue: Queue,
    @InjectQueue('document-extraction') private readonly extractionQueue: Queue,
    private readonly files: ImageKitService,
  ) {}

  @Get()
  async list(@Query('page') page = '1', @Query('limit') limit = '20', @Query('search') search = '', @Query('status') status = '', @Req() req: any) {
    const filter: Record<string, any> = req.user.role === Role.ANGGOTA_SPI ? { createdBy: req.user.sub } : {};
    if (status) filter.status = status;
    if (search.trim()) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ 'data.title': { $regex: escaped, $options: 'i' } }, { 'data.unit': { $regex: escaped, $options: 'i' } }];
    }
    const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const [reports, total] = await Promise.all([
      this.reports.find(filter).sort({ createdAt: -1 }).skip((currentPage - 1) * pageSize).limit(pageSize).lean(),
      this.reports.countDocuments(filter),
    ]);
    const reportIds = reports.map((report: any) => String(report._id));
    const reviews = reportIds.length ? await this.reviews.find({ reportId: { $in: reportIds } }).sort({ createdAt: -1 }).lean() : [];
    const latestReviewByReport = new Map<string, any>();
    for (const review of reviews) {
      const key = String(review.reportId);
      if (!latestReviewByReport.has(key)) latestReviewByReport.set(key, review);
    }
    return {
      items: reports.map((report: any) => ({ ...report, latestReview: latestReviewByReport.get(String(report._id)) || null })),
      page: currentPage, limit: pageSize, total,
    };
  }

  @Post()
  @Roles(Role.ADMIN_SPI, Role.ANGGOTA_SPI)
  create(@Body() dto: ReportDto, @Req() req: any) { return this.reports.create({ data: dto, createdBy: req.user.sub, status: 'UPLOADED', version: 0 }); }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: any) {
    const report = await this.reports.findById(id).lean();
    this.assertReadAccess(report, req.user);
    return report;
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Daftar versi laporan yang tersimpan' })
  async listVersions(@Param('id') id: string, @Req() req: any) {
    const report = await this.reports.findById(id).lean();
    this.assertReadAccess(report, req.user);
    return this.versions.find({ reportId: id }).sort({ version: -1, createdAt: -1 }).lean();
  }

  @Get(':id/versions/:versionId')
  @ApiOperation({ summary: 'Detail versi laporan beserta status ekstraksi' })
  async getVersion(@Param('id') id: string, @Param('versionId') versionId: string, @Req() req: any) {
    const report = await this.reports.findById(id).lean();
    this.assertReadAccess(report, req.user);
    const version = await this.versions.findOne({ _id: versionId, reportId: id }).lean();
    if (!version) throw new NotFoundException('Versi laporan tidak ditemukan');
    return version;
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 20971520) }, fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf') }))
  @ApiConsumes('multipart/form-data')
  async addVersion(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Body() dto: any, @Req() req: any) {
    if (!file) throw new BadRequestException('File PDF wajib diunggah');
    const report: any = await this.reports.findById(id);
    this.assertReadAccess(report, req.user);
    const versionNumber = Number(report.version || 0) + 1;
    const versionId = new Types.ObjectId();
    let uploaded: any;
    try {
      uploaded = await this.files.upload(file.buffer, file.originalname, `/spi/reports/${id}/${versionId}`);
      const version = await this.versions.create({ _id: versionId, reportId: id, version: versionNumber, createdBy: req.user.sub, status: 'PROCESSING', data: {
        ...dto,
        file: { provider: 'imagekit', fileId: uploaded.fileId, fileName: uploaded.name, filePath: uploaded.filePath, url: uploaded.url, mimeType: file.mimetype, sizeBytes: file.size, uploadedBy: req.user.sub, uploadedAt: new Date(), status: 'UPLOADED' },
      } });
      report.version = versionNumber;
      report.status = 'PROCESSING';
      await report.save();
      await this.extractionQueue.add('extract', { entityType: 'REPORT', documentId: id, versionId: String(version._id), url: uploaded.url }, {
        jobId: `report-extract-${version._id}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 100, removeOnFail: 500,
      });
      return version;
    } catch (error) {
      if (uploaded?.fileId) await this.files.delete(uploaded.fileId).catch(() => undefined);
      throw error;
    }
  }

  @Post(':id/versions/:versionId/reprocess')
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async reprocessVersion(@Param('id') id: string, @Param('versionId') versionId: string, @Req() req: any) {
    const report = await this.reports.findById(id).lean();
    this.assertReadAccess(report, req.user);
    const version: any = await this.versions.findOne({ _id: versionId, reportId: id }).lean();
    if (!version) throw new NotFoundException('Versi laporan tidak ditemukan');
    if (!version.data?.file?.filePath && !version.data?.file?.url) throw new ConflictException('File versi laporan tidak tersedia untuk diproses ulang');

    await this.versions.updateOne({ _id: versionId }, { $set: {
      status: 'PROCESSING',
      'data.processing': { status: 'PROCESSING', retriedAt: new Date() },
    } });
    await this.reports.updateOne({ _id: id }, { $set: { status: 'PROCESSING', 'data.extractionStatus': 'PROCESSING' } });
    const job = await this.extractionQueue.add('extract', {
      entityType: 'REPORT', documentId: id, versionId: String(versionId),
    }, {
      jobId: `report-reprocess-${versionId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return { accepted: true, reportId: id, reportVersionId: String(versionId), jobId: job.id };
  }

  @Post(':id/reviews')
  @ApiOperation({ summary: 'Masukkan review AI ke antrean untuk versi laporan terbaru' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async enqueueReview(@Param('id') id: string, @Req() req: any) {
    const report: any = await this.reports.findById(id).lean();
    this.assertReadAccess(report, req.user);
    const latestVersion: any = await this.versions.findOne({ reportId: id }).sort({ version: -1, createdAt: -1 }).lean();
    if (!latestVersion || latestVersion.status !== 'EXTRACTED') throw new ConflictException('Pemrosesan file laporan harus selesai tanpa halaman yang perlu pemeriksaan manual sebelum review AI');
    return this.queueReview(id, latestVersion, req.user.sub);
  }

  @Post(':id/ai-review')
  @ApiOperation({ summary: 'Alias eksplisit untuk memulai AI review laporan' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async startAiReview(@Param('id') id: string, @Req() req: any) { return this.enqueueReview(id, req); }

  @Get(':id/ai-review')
  async getAiReviews(@Param('id') id: string, @Req() req: any) { return this.reviewHistory(id, req); }

  @Get(':id/ai-review/:reviewId')
  @ApiOperation({ summary: 'Detail snapshot review AI dengan temuan dan sumber terverifikasi' })
  async getAiReview(@Param('id') id: string, @Param('reviewId') reviewId: string, @Req() req: any) {
    const report = await this.reports.findById(id).lean();
    this.assertReadAccess(report, req.user);
    const review: any = await this.reviews.findOne({ _id: reviewId, reportId: id }).lean();
    if (!review) throw new NotFoundException('Evaluasi AI tidak ditemukan');
    const [findings, sources, recommendations] = await Promise.all([
      this.findings.find({ reviewId }).lean(), this.reviewSources.find({ reviewId }).lean(), this.recommendations.find({ reviewId }).lean(),
    ]);
    return { ...review, findings, sources, recommendations };
  }

  @Post(':id/ai-review/:reviewId/retry')
  @ApiOperation({ summary: 'Ulangi review yang gagal sebagai snapshot baru' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async retryAiReview(@Param('id') id: string, @Param('reviewId') reviewId: string, @Req() req: any) {
    const report = await this.reports.findById(id).lean();
    this.assertReadAccess(report, req.user);
    const oldReview: any = await this.reviews.findOne({ _id: reviewId, reportId: id }).lean();
    if (!oldReview) throw new NotFoundException('Evaluasi AI tidak ditemukan');
    if (oldReview.status !== 'FAILED' && oldReview.data?.status !== 'FAILED') throw new ConflictException('Hanya evaluasi gagal yang dapat dicoba ulang');
    const version: any = await this.versions.findOne({ _id: oldReview.reportVersionId, reportId: id }).lean();
    if (!version) throw new ConflictException('Versi laporan sumber evaluasi sudah tidak tersedia');
    if (version.status !== 'EXTRACTED') throw new ConflictException('Pemrosesan versi laporan harus selesai sebelum review AI');
    return this.queueReview(id, version, req.user.sub, String(oldReview._id));
  }

  @Get(':id/ai-review/:reviewId/findings')
  @ApiOperation({ summary: 'Daftar temuan pada snapshot AI review' })
  async listFindings(@Param('id') id: string, @Param('reviewId') reviewId: string, @Req() req: any) {
    await this.assertReviewAccess(id, reviewId, req.user);
    return this.findings.find({ reportId: id, reviewId }).sort({ createdAt: 1 }).lean();
  }

  @Get(':id/ai-review/:reviewId/findings/:findingId')
  @ApiOperation({ summary: 'Detail temuan, bukti laporan, dan sumber regulasi' })
  async getFinding(@Param('id') id: string, @Param('reviewId') reviewId: string, @Param('findingId') findingId: string, @Req() req: any) {
    await this.assertReviewAccess(id, reviewId, req.user);
    const finding = await this.findings.findOne({ _id: findingId, reportId: id, reviewId }).lean();
    if (!finding) throw new NotFoundException('Temuan evaluasi tidak ditemukan');
    const sources = await this.reviewSources.find({ reviewId, findingId }).lean();
    return { ...finding, sources };
  }

  @Patch(':id/ai-review/:reviewId/findings/:findingId')
  @ApiOperation({ summary: 'Catat hasil verifikasi manusia untuk temuan' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async updateFinding(@Param('id') id: string, @Param('reviewId') reviewId: string, @Param('findingId') findingId: string, @Body() dto: FindingReviewDto, @Req() req: any) {
    await this.assertReviewAccess(id, reviewId, req.user);
    if (!await this.reviews.exists({ _id: reviewId, reportId: id, status: 'COMPLETED' })) throw new ConflictException('Temuan belum tersedia untuk evaluasi manusia');
    const updated = await this.findings.findOneAndUpdate({ _id: findingId, reportId: id, reviewId }, { $set: {
      ...(dto.complianceStatus ? { 'humanReview.complianceStatus': dto.complianceStatus } : {}),
      ...(dto.reviewerNote !== undefined ? { 'humanReview.note': dto.reviewerNote } : {}),
      'humanReview.reviewerId': req.user.sub, 'humanReview.reviewedAt': new Date(),
    } }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Temuan evaluasi tidak ditemukan');
    await this.evaluationHistory.create({ reportId: id, actorId: req.user.sub, action: 'FINDING_HUMAN_REVIEW_UPDATED', metadata: { reviewId, findingId, complianceStatus: dto.complianceStatus } });
    return updated;
  }

  @Get(':id/ai-review/:reviewId/regulation-mapping')
  @ApiOperation({ summary: 'Daftar mapping temuan ke passage dokumen acuan' })
  async regulationMappings(@Param('id') id: string, @Param('reviewId') reviewId: string, @Req() req: any) {
    await this.assertReviewAccess(id, reviewId, req.user);
    const sources = await this.reviewSources.find({ reportId: id, reviewId }).sort({ pageStart: 1 }).lean();
    const findings = await this.findings.find({ reportId: id, reviewId }).select('_id title complianceStatus sourceChunkIds').lean();
    return sources.map((source: any) => ({ ...source, findings: findings.filter((finding: any) => finding.sourceChunkIds?.includes(source.chunkId)) }));
  }

  @Get(':id/ai-review/:reviewId/regulation-mapping/:mappingId')
  @ApiOperation({ summary: 'Detail mapping sumber regulasi' })
  async regulationMapping(@Param('id') id: string, @Param('reviewId') reviewId: string, @Param('mappingId') mappingId: string, @Req() req: any) {
    await this.assertReviewAccess(id, reviewId, req.user);
    const mapping = await this.reviewSources.findOne({ _id: mappingId, reportId: id, reviewId }).lean();
    if (!mapping) throw new NotFoundException('Referensi regulasi tidak ditemukan');
    return mapping;
  }

  @Get(':id/reviews')
  async reviewHistory(@Param('id') id: string, @Req() req: any) {
    const report = await this.reports.findById(id).lean();
    this.assertReadAccess(report, req.user);
    const reviews = await this.reviews.find({ reportId: id }).sort({ createdAt: -1 }).limit(20).lean();
    const results = await Promise.all(reviews.map(async (review: any) => ({
      ...review,
      findings: await this.findings.find({ reviewId: review._id }).lean(),
      sources: await this.reviewSources.find({ reviewId: review._id }).lean(),
    })));
    return results;
  }

  @Post(':id/approve')
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async approve(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    const report = await this.reports.findById(id);
    if (!report) throw new NotFoundException('Laporan tidak ditemukan');
    const approval = await this.approvals.create({ reportId: id, decision: 'APPROVED', note: body.note, reviewerId: req.user.sub });
    await this.reports.findByIdAndUpdate(id, { status: 'APPROVED' });
    await this.evaluationHistory.create({ reportId: id, actorId: req.user.sub, action: 'REPORT_APPROVED_LEGACY_ROUTE', toStatus: 'APPROVED', note: body.note || '' });
    return approval;
  }

  @Post(':id/request-revision')
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async requestRevision(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    const report = await this.reports.findById(id);
    if (!report) throw new NotFoundException('Laporan tidak ditemukan');
    const approval = await this.approvals.create({ reportId: id, decision: 'NEEDS_REVISION', note: body.note, reviewerId: req.user.sub });
    await this.reports.findByIdAndUpdate(id, { status: 'NEEDS_REVISION' });
    await this.evaluationHistory.create({ reportId: id, actorId: req.user.sub, action: 'REPORT_REVISION_REQUESTED_LEGACY_ROUTE', toStatus: 'NEEDS_REVISION', note: body.note || '' });
    return approval;
  }

  private assertReadAccess(report: any, user: any) {
    if (!report) throw new NotFoundException('Laporan tidak ditemukan');
    if (user.role === Role.ANGGOTA_SPI && report.createdBy !== user.sub) throw new ForbiddenException('Tidak memiliki akses ke laporan ini');
  }

  private async assertReviewAccess(reportId: string, reviewId: string, user: any) {
    const report = await this.reports.findById(reportId).lean();
    this.assertReadAccess(report, user);
    if (!await this.reviews.exists({ _id: reviewId, reportId })) throw new NotFoundException('Evaluasi AI tidak ditemukan');
  }

  private async queueReview(reportId: string, version: any, userId: string, retryOf?: string) {
    const reviewId = new Types.ObjectId();
    const jobId = `report-review-${reviewId}`;
    const review = await this.reviews.create({ _id: reviewId, reportId, reportVersionId: version._id, reviewerId: userId, jobId, status: 'PROCESSING', data: {
      status: 'AI_REVIEW_PROCESSING', humanVerificationStatus: 'PENDING', retryOf: retryOf || null,
      queuedAt: new Date(), reportVersionNumber: version.version,
    } });
    try {
      const job = await this.reviewQueue.add('review', { reportId, userId, reportVersionId: String(version._id), reviewId: String(reviewId) }, {
        jobId, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 100, removeOnFail: 500,
      });
      return { queued: true, jobId: job.id, reviewId: review._id, reportVersionId: version._id };
    } catch (error) {
      await this.reviews.updateOne({ _id: review._id }, { $set: { status: 'FAILED', 'data.status': 'FAILED', 'data.failedAt': new Date() } });
      throw error;
    }
  }
}
