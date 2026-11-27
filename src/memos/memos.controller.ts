import {
  BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post,
  Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsMongoId, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';
import { ImageKitService } from '../files/imagekit.service';

class CreateMemoDto {
  @IsString() @MaxLength(120) memoNumber: string;
  @IsString() @MaxLength(500) recipient: string;
  @IsOptional() @IsString() @MaxLength(2000) cc?: string;
  @IsString() @MaxLength(300) fromUnit: string;
  @IsString() @MaxLength(1000) subject: string;
  @IsDateString() memoDate: string;
  @IsMongoId() reportId: string;
  @IsMongoId() reportReviewId: string;
}
class MemoStatusDto { @IsIn(['SENT_TO_SHEYLA', 'SENT_TO_DIRECTOR']) status: string; }
class DispositionTextDto { @IsString() @MinLength(5) @MaxLength(10000) text: string; }
class ManualFollowUpDto {
  @IsString() @MaxLength(500) title: string;
  @IsString() @MaxLength(8000) description: string;
  @IsOptional() @IsString() @MaxLength(4000) action?: string;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) priority?: string;
  @IsOptional() @IsMongoId() assigneeId?: string;
  @IsOptional() @IsDateString() dueDate?: string;
}

@ApiTags('Memos and Follow-up')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('memos')
export class MemosController {
  constructor(
    @InjectModel('Memo') private readonly memos: Model<any>,
    @InjectModel('Report') private readonly reports: Model<any>,
    @InjectModel('ReportVersion') private readonly versions: Model<any>,
    @InjectModel('DocumentPage') private readonly pages: Model<any>,
    @InjectModel('Review') private readonly reviews: Model<any>,
    @InjectModel('Recommendation') private readonly recommendations: Model<any>,
    @InjectModel('FollowUp') private readonly followUps: Model<any>,
    @InjectModel('Task') private readonly tasks: Model<any>,
    @InjectModel('User') private readonly users: Model<any>,
    @InjectQueue('document-extraction') private readonly extractionQueue: Queue,
    @InjectQueue('report-review') private readonly reviewQueue: Queue,
    private readonly files: ImageKitService,
  ) {}

  @Get()
  async list(@Query('page') page = '1', @Query('limit') limit = '20') {
    const currentPage = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
    const [items, total] = await Promise.all([
      this.memos.find().sort({ createdAt: -1 }).skip((currentPage - 1) * pageSize).limit(pageSize).lean(),
      this.memos.countDocuments(),
    ]);
    const reportIds = items.map((item: any) => item.reportId);
    const reports = reportIds.length ? await this.reports.find({ _id: { $in: reportIds } }).select('data.title').lean() : [];
    const titles = new Map(reports.map((report: any) => [String(report._id), report.data?.title || 'Laporan tanpa judul']));
    return { items: items.map((item: any) => ({ ...item, reportTitle: titles.get(String(item.reportId)) })), page: currentPage, limit: pageSize, total };
  }

  @Post()
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async create(@Body() dto: CreateMemoDto, @Req() req: any) {
    const report = await this.reports.findById(dto.reportId).lean();
    if (!report) throw new NotFoundException('Laporan tidak ditemukan');
    const review = await this.reviews.findOne({ _id: dto.reportReviewId, reportId: dto.reportId, status: 'COMPLETED' }).lean();
    if (!review) throw new ConflictException('Memo hanya dapat dibuat dari laporan yang sudah selesai direview AI');
    const cc = String(dto.cc || '').split(/[;,\n]/).map((value) => value.trim()).filter(Boolean);
    return this.memos.create({ ...dto, cc, memoDate: new Date(dto.memoDate), status: 'DRAFT', createdBy: req.user.sub, statusHistory: [{ status: 'DRAFT', changedBy: req.user.sub, changedAt: new Date() }] });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const memo: any = await this.memos.findById(id).lean();
    if (!memo) throw new NotFoundException('Memo tidak ditemukan');
    const [report, dispositionVersion] = await Promise.all([
      this.reports.findById(memo.reportId).select('data.title status').lean(),
      memo.dispositionVersionId ? this.versions.findById(memo.dispositionVersionId).lean() : null,
    ]);
    return { ...memo, report, dispositionVersion };
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async changeStatus(@Param('id') id: string, @Body() dto: MemoStatusDto, @Req() req: any) {
    const memo: any = await this.memos.findById(id);
    if (!memo) throw new NotFoundException('Memo tidak ditemukan');
    const allowed = memo.status === 'DRAFT' && dto.status === 'SENT_TO_SHEYLA'
      || memo.status === 'SENT_TO_SHEYLA' && dto.status === 'SENT_TO_DIRECTOR';
    if (!allowed) throw new ConflictException('Perubahan status memo tidak sesuai urutan proses');
    memo.status = dto.status;
    memo.statusHistory.push({ status: dto.status, changedBy: req.user.sub, changedAt: new Date() });
    await memo.save();
    return memo.toObject();
  }

  @Post(':id/disposition')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 20971520) }, fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf') }))
  @ApiConsumes('multipart/form-data')
  async uploadDisposition(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new BadRequestException('File disposisi direktur berformat PDF wajib diunggah');
    const memo: any = await this.memos.findById(id);
    if (!memo) throw new NotFoundException('Memo tidak ditemukan');
    if (memo.status !== 'SENT_TO_DIRECTOR') throw new ConflictException('Memo harus berstatus dikirim ke direktur sebelum disposisi diunggah');
    const report: any = await this.reports.findById(memo.reportId);
    if (!report) throw new NotFoundException('Laporan terkait tidak ditemukan');
    const versionNumber = Number(report.version || 0) + 1;
    const versionId = new Types.ObjectId();
    let uploaded: any;
    try {
      uploaded = await this.files.upload(file.buffer, file.originalname, `/spi/memos/${id}/disposition/${versionId}`);
      await this.versions.create({ _id: versionId, reportId: String(memo.reportId), version: versionNumber, createdBy: req.user.sub, status: 'PROCESSING', data: {
        documentRole: 'DIRECTOR_DISPOSITION', reviewPurpose: 'DIRECTOR_DISPOSITION', memoId: String(memo._id), baseReviewId: String(memo.reportReviewId),
        file: { provider: 'imagekit', fileId: uploaded.fileId, fileName: uploaded.name, filePath: uploaded.filePath, url: uploaded.url, mimeType: file.mimetype, sizeBytes: file.size, uploadedBy: req.user.sub, uploadedAt: new Date(), status: 'UPLOADED' },
      } });
      report.version = versionNumber;
      report.status = 'PROCESSING';
      await report.save();
      await this.extractionQueue.add('extract', { entityType: 'REPORT', documentId: String(memo.reportId), versionId: String(versionId) }, {
        jobId: `disposition-extract-${versionId}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 100, removeOnFail: 500,
      });
      memo.dispositionVersionId = versionId;
      memo.dispositionReviewId = null;
      memo.status = 'DISPOSITION_RECEIVED';
      memo.statusHistory.push({ status: 'DISPOSITION_RECEIVED', changedBy: req.user.sub, changedAt: new Date(), fileName: uploaded.name });
      await memo.save();
      return { memo: memo.toObject(), reportVersionId: String(versionId), extractionStatus: 'PROCESSING' };
    } catch (error) {
      if (uploaded?.fileId) await this.files.delete(uploaded.fileId).catch(() => undefined);
      throw error;
    }
  }

  @Post(':id/disposition-text')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async submitDispositionText(@Param('id') id: string, @Body() dto: DispositionTextDto, @Req() req: any) {
    const text = dto.text.trim();
    if (text.length < 5) throw new BadRequestException('Isi arahan disposisi minimal 5 karakter');
    const memo: any = await this.memos.findById(id);
    if (!memo) throw new NotFoundException('Memo tidak ditemukan');
    if (memo.status !== 'SENT_TO_DIRECTOR') throw new ConflictException('Memo harus berstatus dikirim ke Direktur sebelum isi disposisi dicatat');
    const report: any = await this.reports.findById(memo.reportId);
    if (!report) throw new NotFoundException('Laporan terkait tidak ditemukan');
    const baseReview: any = await this.reviews.findOne({ _id: memo.reportReviewId, reportId: memo.reportId, status: 'COMPLETED' }).lean();
    if (!baseReview) throw new ConflictException('Hasil review laporan yang dikirim ke Direktur tidak tersedia');

    const versionNumber = Number(report.version || 0) + 1;
    const versionId = new Types.ObjectId();
    await this.versions.create({
      _id: versionId,
      reportId: String(memo.reportId),
      version: versionNumber,
      createdBy: req.user.sub,
      status: 'EXTRACTED',
      data: {
        documentRole: 'DIRECTOR_DISPOSITION',
        reviewPurpose: 'DIRECTOR_DISPOSITION',
        memoId: String(memo._id),
        baseReviewId: String(baseReview._id),
        extractedText: text,
        disposition: { inputMethod: 'MANUAL_TEXT', text, enteredBy: req.user.sub, enteredAt: new Date() },
        processing: { status: 'EXTRACTED', source: 'MANUAL_TRANSCRIPTION', pageCount: 1, processedAt: new Date() },
      },
    });
    await this.pages.updateOne(
      { documentVersionId: String(versionId), pageNumber: 1 },
      { $set: { documentVersionId: String(versionId), pageNumber: 1, text, status: 'MANUAL_TRANSCRIPTION', extractedAt: new Date() } },
      { upsert: true },
    );
    report.version = versionNumber;
    report.status = 'UNDER_REVIEW';
    await report.save();

    memo.dispositionVersionId = versionId;
    memo.dispositionReviewId = null;
    memo.status = 'DISPOSITION_RECEIVED';
    memo.statusHistory.push({ status: 'DISPOSITION_RECEIVED', changedBy: req.user.sub, changedAt: new Date(), inputMethod: 'MANUAL_TEXT' });
    await memo.save();
    return { memo: memo.toObject(), reportVersionId: String(versionId), extractionStatus: 'EXTRACTED', inputMethod: 'MANUAL_TEXT' };
  }

  @Post(':id/disposition-review')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async startDispositionReview(@Param('id') id: string, @Req() req: any) {
    const memo: any = await this.memos.findById(id).lean();
    if (!memo) throw new NotFoundException('Memo tidak ditemukan');
    if (memo.status !== 'DISPOSITION_RECEIVED' || !memo.dispositionVersionId) throw new ConflictException('Unggah disposisi direktur terlebih dahulu');
    const version: any = await this.versions.findById(memo.dispositionVersionId).lean();
    if (!version || version.status !== 'EXTRACTED') throw new ConflictException('Teks disposisi harus tersedia dan siap ditinjau terlebih dahulu');
    const prior: any = await this.reviews.findOne({ reportId: memo.reportId, reportVersionId: version._id, 'data.memoId': String(memo._id) }).sort({ createdAt: -1 }).lean();
    if (prior?.status === 'PROCESSING') {
      const ageMs = Date.now() - new Date(prior.createdAt || Date.now()).getTime();
      if (ageMs < 8 * 60 * 1000) return { queued: true, reviewId: String(prior._id), status: prior.status, stale: false };
      const oldJob = prior.jobId ? await this.reviewQueue.getJob(String(prior.jobId)) : null;
      if (oldJob) {
        const oldState = await oldJob.getState();
        if (oldState === 'active') await oldJob.discard();
        else await oldJob.remove().catch(() => undefined);
      }
      await this.reviews.updateOne({ _id: prior._id }, { $set: { status: 'FAILED', 'data.status': 'FAILED', 'data.failedAt': new Date(), 'data.failureReason': 'Review melewati batas waktu 8 menit; job baru dimulai.' } });
    }
    if (prior?.status === 'COMPLETED') return { queued: false, reviewId: String(prior._id), status: prior.status };
    const reviewId = new Types.ObjectId();
    const jobId = `disposition-review-${reviewId}`;
    await this.reviews.create({ _id: reviewId, reportId: memo.reportId, reportVersionId: version._id, reviewerId: req.user.sub, jobId, status: 'PROCESSING', data: { status: 'AI_REVIEW_PROCESSING', humanVerificationStatus: 'PENDING', memoId: String(memo._id), reviewPurpose: 'DIRECTOR_DISPOSITION', queuedAt: new Date() } });
    try {
      await this.reviewQueue.add('review', { reportId: String(memo.reportId), userId: req.user.sub, reportVersionId: String(version._id), reviewId: String(reviewId), memoId: String(memo._id), reviewPurpose: 'DIRECTOR_DISPOSITION' }, {
        jobId, attempts: 1, removeOnComplete: 100, removeOnFail: 500,
      });
      await this.memos.updateOne({ _id: id }, { $set: { dispositionReviewId: reviewId } });
      return { queued: true, jobId, reviewId: String(reviewId), reportVersionId: String(version._id) };
    } catch (error) {
      await this.reviews.updateOne({ _id: reviewId }, { $set: { status: 'FAILED', 'data.status': 'FAILED', 'data.failedAt': new Date() } });
      throw error;
    }
  }

  @Get(':id/disposition-review')
  async getDispositionReview(@Param('id') id: string) {
    const memo: any = await this.memos.findById(id).lean();
    if (!memo) throw new NotFoundException('Memo tidak ditemukan');
    if (!memo.dispositionVersionId) return { review: null, recommendations: [] };
    const review: any = await this.reviews.findOne({ reportId: memo.reportId, reportVersionId: memo.dispositionVersionId, 'data.memoId': String(memo._id) }).sort({ createdAt: -1 }).lean();
    if (!review) return { review: null, recommendations: [] };
    const recommendations = await this.recommendations.find({ reportId: memo.reportId, reviewId: review._id }).sort({ createdAt: 1 }).lean();
    return { review, recommendations };
  }

  @Post(':id/follow-ups/manual')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async createManualFollowUp(@Param('id') id: string, @Body() dto: ManualFollowUpDto, @Req() req: any) {
    const memo: any = await this.memos.findById(id).lean();
    if (!memo) throw new NotFoundException('Memo tidak ditemukan');
    const review: any = await this.reviews.findOne({ reportId: memo.reportId, 'data.memoId': String(memo._id), status: 'COMPLETED' }).sort({ createdAt: -1 }).lean()
      || await this.reviews.findOne({ _id: memo.reportReviewId, reportId: memo.reportId, status: 'COMPLETED' }).lean();
    if (!review) throw new ConflictException('Laporan harus memiliki hasil AI review selesai sebelum tindak lanjut dibuat');
    if (dto.assigneeId) {
      const user: any = await this.users.findOne({ _id: dto.assigneeId, active: true }).select('role').lean();
      if (!user || user.role !== Role.ANGGOTA_SPI) throw new BadRequestException('Penanggung jawab harus merupakan anggota SPI aktif');
    }
    const recommendation = await this.recommendations.create({ reportId: memo.reportId, reportVersionId: review.reportVersionId, reviewId: review._id, type: 'INSPECTION_IMPROVEMENT', title: dto.title, description: dto.description, rationale: 'Tindak lanjut manual berdasarkan pengetahuan dan keputusan SPI.', action: dto.action || dto.description, priority: dto.priority || 'MEDIUM', status: 'APPROVED', verificationStatus: 'SUPPORTED', sourceChunkIds: [], createdBy: req.user.sub, sourceMemoId: String(memo._id), reviewNote: 'Ditambahkan manual oleh Admin/Pimpinan SPI.' });
    const taskId = new Types.ObjectId();
    const followUpId = new Types.ObjectId();
    const assigneeId = dto.assigneeId ? new Types.ObjectId(dto.assigneeId) : null;
    const status = assigneeId ? 'ASSIGNED' : 'OPEN';
    const dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    await this.tasks.create({ _id: taskId, createdBy: req.user.sub, status, data: { title: dto.title, description: dto.description, priority: dto.priority || 'MEDIUM', assigneeId: assigneeId ? String(assigneeId) : null, dueDate, followUp: { followUpId: String(followUpId), reportId: String(memo.reportId), reportVersionId: String(review.reportVersionId), reviewId: String(review._id), recommendationId: String(recommendation._id), memoId: String(memo._id) } } });
    const followUp = await this.followUps.create({ _id: followUpId, reportId: memo.reportId, reportVersionId: review.reportVersionId, reviewId: review._id, recommendationId: recommendation._id, taskId, status, assigneeId, dueDate, createdBy: req.user.sub });
    if (await this.reports.exists({ _id: memo.reportId, status: 'APPROVED' })) await this.reports.updateOne({ _id: memo.reportId }, { $set: { status: 'FOLLOW_UP' } });
    return { ...followUp.toObject(), recommendation, task: await this.tasks.findById(taskId).lean() };
  }
}
