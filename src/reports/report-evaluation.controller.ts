import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get,
  NotFoundException, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsMongoId, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Model, Types } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';
import { ImageKitService } from '../files/imagekit.service';
import { canAccessFollowUp, canCreateFollowUpFromRecommendation, canTransitionFollowUpStatus } from './evaluation.rules';
import { User, UserDocument } from '../users/user.schema';

class RecommendationUpdateDto {
  @ApiProperty({ required: false, maxLength: 4000 })
  @IsOptional() @IsString() @MaxLength(4000) reviewNote?: string;
  @ApiProperty({ required: false, maxLength: 4000 })
  @IsOptional() @IsString() @MaxLength(4000) action?: string;
  @ApiProperty({ required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) priority?: string;
  @ApiProperty({ required: false, enum: ['SUPPORTED', 'NEEDS_VERIFICATION'] })
  @IsOptional() @IsIn(['SUPPORTED', 'NEEDS_VERIFICATION']) verificationStatus?: string;
}
class DecisionNoteDto { @ApiProperty({ required: false, maxLength: 10000 }) @IsOptional() @IsString() @MaxLength(10000) note?: string; }
class FindingDecisionDto {
  @ApiProperty() 
  @IsMongoId() findingId: string;
  @ApiProperty({ enum: ['COMPLIANT', 'NON_COMPLIANT', 'PARTIALLY_COMPLIANT', 'NOT_ASSESSABLE'] })
  @IsIn(['COMPLIANT', 'NON_COMPLIANT', 'PARTIALLY_COMPLIANT', 'NOT_ASSESSABLE']) status: string;
  @ApiProperty({ required: false, maxLength: 4000 })
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
}
class FollowUpCreateDto {
  @ApiProperty() 
  @IsMongoId() recommendationId: string;
  @ApiProperty({ required: false })
  @IsOptional() @IsMongoId() assigneeId?: string;
  @ApiProperty({ required: false, format: 'date-time' })
  @IsOptional() @IsDateString() dueDate?: string;
}
class FollowUpVerifyDto {
  @ApiProperty({ enum: ['COMPLETED', 'REVISION_REQUIRED', 'REJECTED'] })
  @IsIn(['COMPLETED', 'REVISION_REQUIRED', 'REJECTED']) decision: string;
  @ApiProperty({ required: false, maxLength: 4000 })
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
}
class EvaluationCreateDto { @ApiProperty({ required: false }) @IsOptional() @IsMongoId() reviewId?: string; @ApiProperty({ required: false, maxLength: 10000 }) @IsOptional() @IsString() @MaxLength(10000) note?: string; }
class EvaluationUpdateDto {
  @ApiProperty({ required: false, maxLength: 10000 })
  @IsOptional() @IsString() @MaxLength(10000) note?: string;
  @ApiProperty({ required: false, type: [FindingDecisionDto], maxItems: 200 })
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => FindingDecisionDto) findingDecisions?: FindingDecisionDto[];
}
class FollowUpStatusDto { @ApiProperty({ enum: ['IN_PROGRESS'] }) @IsIn(['IN_PROGRESS']) status: string; }

@ApiTags('Report Evaluation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports/:reportId')
export class ReportEvaluationController {
  constructor(
    @InjectModel('Report') private readonly reports: Model<any>,
    @InjectModel('Review') private readonly reviews: Model<any>,
    @InjectModel('ReviewFinding') private readonly findings: Model<any>,
    @InjectModel('Recommendation') private readonly recommendations: Model<any>,
    @InjectModel('HumanEvaluation') private readonly evaluations: Model<any>,
    @InjectModel('FollowUp') private readonly followUps: Model<any>,
    @InjectModel('FollowUpEvidence') private readonly evidence: Model<any>,
    @InjectModel('EvaluationHistory') private readonly history: Model<any>,
    @InjectModel('Task') private readonly tasks: Model<any>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly files: ImageKitService,
  ) {}

  @Get('ai-review/:reviewId/recommendations')
  @ApiOperation({ summary: 'Daftar rekomendasi pada snapshot AI review' })
  async listRecommendations(@Param('reportId') reportId: string, @Param('reviewId') reviewId: string, @Query('page') page = '1', @Query('limit') limit = '20', @Req() req: any) {
    await this.assertReviewAccess(reportId, reviewId, req.user);
    const p = this.pageNumber(page), l = this.pageSize(limit);
    const filter = { reportId, reviewId };
    const [items, total] = await Promise.all([this.recommendations.find(filter).sort({ createdAt: 1 }).skip((p - 1) * l).limit(l).lean(), this.recommendations.countDocuments(filter)]);
    return { items, page: p, limit: l, total };
  }

  @Patch('ai-review/:reviewId/recommendations/:recommendationId')
  @ApiOperation({ summary: 'Perbarui catatan, tindakan, prioritas, atau verifikasi rekomendasi' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async updateRecommendation(@Param('reportId') reportId: string, @Param('reviewId') reviewId: string, @Param('recommendationId') recommendationId: string, @Body() dto: RecommendationUpdateDto, @Req() req: any) {
    await this.assertReviewAccess(reportId, reviewId, req.user);
    if (!await this.reviews.exists({ _id: reviewId, reportId, status: 'COMPLETED' })) throw new ConflictException('Rekomendasi belum tersedia untuk evaluasi manusia');
    const updated = await this.recommendations.findOneAndUpdate({ _id: recommendationId, reportId, reviewId, status: { $in: ['PENDING_REVIEW', 'NEEDS_VERIFICATION'] } }, { $set: {
      ...(dto.reviewNote !== undefined ? { reviewNote: dto.reviewNote } : {}),
      ...(dto.action !== undefined ? { action: dto.action } : {}),
      ...(dto.priority ? { priority: dto.priority } : {}), reviewedBy: req.user.sub, reviewedAt: new Date(),
      ...(dto.verificationStatus ? { verificationStatus: dto.verificationStatus, ...(dto.verificationStatus === 'SUPPORTED' ? { status: 'PENDING_REVIEW' } : { status: 'NEEDS_VERIFICATION' }) } : {}),
    } }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Rekomendasi yang masih dapat ditinjau tidak ditemukan');
    await this.writeHistory({ reportId, actorId: req.user.sub, action: 'RECOMMENDATION_UPDATED', metadata: { recommendationId } });
    return updated;
  }

  @Post('ai-review/:reviewId/recommendations/:recommendationId/approve')
  @ApiOperation({ summary: 'Setujui rekomendasi AI setelah verifikasi manusia' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  approveRecommendation(@Param('reportId') reportId: string, @Param('reviewId') reviewId: string, @Param('recommendationId') recommendationId: string, @Body() dto: DecisionNoteDto, @Req() req: any) {
    return this.decideRecommendation(reportId, reviewId, recommendationId, 'APPROVED', dto.note, req.user);
  }

  @Post('ai-review/:reviewId/recommendations/:recommendationId/reject')
  @ApiOperation({ summary: 'Tolak rekomendasi AI' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  rejectRecommendation(@Param('reportId') reportId: string, @Param('reviewId') reviewId: string, @Param('recommendationId') recommendationId: string, @Body() dto: DecisionNoteDto, @Req() req: any) {
    return this.decideRecommendation(reportId, reviewId, recommendationId, 'REJECTED', dto.note, req.user);
  }

  @Post('evaluations')
  @ApiOperation({ summary: 'Mulai evaluasi manusia untuk snapshot AI' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async createEvaluation(@Param('reportId') reportId: string, @Body() dto: EvaluationCreateDto, @Req() req: any) {
    const report = await this.getReport(reportId, req.user);
    const review: any = dto.reviewId
      ? await this.reviews.findOne({ _id: dto.reviewId, reportId }).lean()
      : await this.reviews.findOne({ reportId, status: 'COMPLETED' }).sort({ createdAt: -1 }).lean();
    if (!review || review.status !== 'COMPLETED') throw new ConflictException('Evaluasi AI yang selesai harus dipilih terlebih dahulu');
    const evaluation = await this.evaluations.create({ reportId, reportVersionId: review.reportVersionId, reviewId: review._id, reviewerId: req.user.sub, note: dto.note || '', status: 'IN_PROGRESS' });
    await this.reviews.updateOne({ _id: review._id }, { $set: { 'data.humanVerificationStatus': 'IN_PROGRESS' } });
    await this.writeHistory({ reportId, evaluationId: evaluation._id, actorId: req.user.sub, action: 'HUMAN_EVALUATION_STARTED', toStatus: 'IN_PROGRESS' });
    return evaluation;
  }

  @Get('evaluations')
  @ApiOperation({ summary: 'Daftar evaluasi manusia laporan' })
  async listEvaluations(@Param('reportId') reportId: string, @Req() req: any) {
    await this.getReport(reportId, req.user);
    return this.evaluations.find({ reportId }).sort({ createdAt: -1 }).limit(100).lean();
  }

  @Get('evaluations/:evaluationId')
  @ApiOperation({ summary: 'Detail evaluasi manusia, temuan, rekomendasi, dan riwayat' })
  async getEvaluation(@Param('reportId') reportId: string, @Param('evaluationId') evaluationId: string, @Req() req: any) {
    await this.getReport(reportId, req.user);
    const evaluation: any = await this.evaluations.findOne({ _id: evaluationId, reportId }).lean();
    if (!evaluation) throw new NotFoundException('Evaluasi manusia tidak ditemukan');
    const [findings, recommendations, history] = await Promise.all([
      evaluation.reviewId ? this.getFindings(evaluation.reviewId) : [],
      evaluation.reviewId ? this.recommendations.find({ reviewId: evaluation.reviewId }).lean() : [],
      this.history.find({ evaluationId }).sort({ createdAt: 1 }).lean(),
    ]);
    return { ...evaluation, findings, recommendations, history };
  }

  @Patch('evaluations/:evaluationId')
  @ApiOperation({ summary: 'Simpan catatan dan keputusan compliance per temuan' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async updateEvaluation(@Param('reportId') reportId: string, @Param('evaluationId') evaluationId: string, @Body() dto: EvaluationUpdateDto, @Req() req: any) {
    await this.getReport(reportId, req.user);
    const current: any = await this.evaluations.findOne({ _id: evaluationId, reportId, status: 'IN_PROGRESS' });
    if (!current) throw new NotFoundException('Evaluasi aktif tidak ditemukan');
    if (dto.note !== undefined) current.note = dto.note;
    if (dto.findingDecisions !== undefined) {
      if (!Array.isArray(dto.findingDecisions) || dto.findingDecisions.length > 200) throw new BadRequestException('findingDecisions tidak valid');
      if (dto.findingDecisions.length && (!current.reviewId || await this.findings.countDocuments({ _id: { $in: dto.findingDecisions.map((item) => item.findingId) }, reviewId: current.reviewId }) !== new Set(dto.findingDecisions.map((item) => item.findingId)).size)) {
        throw new BadRequestException('Semua findingId harus berasal dari review yang sedang dievaluasi');
      }
      current.findingDecisions = dto.findingDecisions.map((item) => ({
        findingId: String(item.findingId), status: item.status,
        note: String(item.note || '').slice(0, 4000),
      }));
    }
    await current.save();
    await this.writeHistory({ reportId, evaluationId, actorId: req.user.sub, action: 'HUMAN_EVALUATION_UPDATED' });
    return current.toObject();
  }

  @Post('evaluations/:evaluationId/approve')
  @ApiOperation({ summary: 'Setujui laporan berdasarkan evaluasi manusia' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async approveEvaluation(@Param('reportId') reportId: string, @Param('evaluationId') evaluationId: string, @Body() dto: DecisionNoteDto, @Req() req: any) {
    return this.finishEvaluation(reportId, evaluationId, 'APPROVED', dto.note, req.user);
  }

  @Post('evaluations/:evaluationId/request-revision')
  @ApiOperation({ summary: 'Minta revisi laporan berdasarkan evaluasi manusia' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async requestEvaluationRevision(@Param('reportId') reportId: string, @Param('evaluationId') evaluationId: string, @Body() dto: DecisionNoteDto, @Req() req: any) {
    return this.finishEvaluation(reportId, evaluationId, 'REVISION_REQUIRED', dto.note, req.user);
  }

  @Post('follow-ups')
  @ApiOperation({ summary: 'Buat task tindak lanjut dari rekomendasi yang disetujui' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async createFollowUp(@Param('reportId') reportId: string, @Body() dto: FollowUpCreateDto, @Req() req: any) {
    const report: any = await this.getReport(reportId, req.user);
    const recommendation: any = await this.recommendations.findOne({ _id: dto.recommendationId, reportId }).lean();
    if (!recommendation) throw new NotFoundException('Rekomendasi tidak ditemukan');
    if (!canCreateFollowUpFromRecommendation(recommendation.status, recommendation.verificationStatus)) throw new ConflictException('Rekomendasi harus disetujui dan diverifikasi sebelum dibuat menjadi tugas');
    if (!await this.reviews.exists({ _id: recommendation.reviewId, reportId, status: 'COMPLETED' })) throw new ConflictException('Snapshot AI review belum selesai');
    const existing: any = await this.followUps.findOne({ recommendationId: recommendation._id }).lean();
    if (existing) return this.followUpDetail(existing._id);
    if (dto.assigneeId) {
      const assignee: any = await this.users.findOne({ _id: dto.assigneeId, active: true }).select('role').lean();
      if (!assignee || assignee.role !== Role.ANGGOTA_SPI) throw new BadRequestException('Penanggung jawab harus merupakan anggota SPI aktif');
    }
    const taskId = new Types.ObjectId();
    const followUpId = new Types.ObjectId();
    const assigneeId = dto.assigneeId ? new Types.ObjectId(dto.assigneeId) : null;
    const status = assigneeId ? 'ASSIGNED' : 'OPEN';
    const approvedEvaluation: any = await this.evaluations.findOne({ reportId, reviewId: recommendation.reviewId, status: 'APPROVED' }).sort({ createdAt: -1 }).lean();
    try {
      await this.tasks.create({ _id: taskId, createdBy: req.user.sub, status, data: {
        title: recommendation.title, description: recommendation.action || recommendation.description,
        priority: recommendation.priority,
        assigneeId: assigneeId ? String(assigneeId) : null, dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        followUp: { followUpId: String(followUpId), reportId, reportVersionId: String(recommendation.reportVersionId), reviewId: String(recommendation.reviewId), evaluationId: approvedEvaluation ? String(approvedEvaluation._id) : null, recommendationId: String(recommendation._id) },
      } });
      const row = await this.followUps.create({ _id: followUpId, reportId, reportVersionId: recommendation.reportVersionId, reviewId: recommendation.reviewId, evaluationId: approvedEvaluation?._id || null, taskId, recommendationId: recommendation._id, status, assigneeId, dueDate: dto.dueDate ? new Date(dto.dueDate) : null, createdBy: req.user.sub });
      if (report.status === 'APPROVED') await this.reports.updateOne({ _id: reportId }, { $set: { status: 'FOLLOW_UP' } });
      await this.writeHistory({ reportId, followUpId, taskId, actorId: req.user.sub, action: 'FOLLOW_UP_CREATED', toStatus: status, metadata: { recommendationId: String(recommendation._id) } });
      return { ...row.toObject(), task: await this.tasks.findById(taskId).lean() };
    } catch (error: any) {
      if (error?.code === 11000) {
        const prior: any = await this.followUps.findOne({ recommendationId: recommendation._id }).lean();
        if (prior) return this.followUpDetail(prior._id);
      }
      await this.tasks.deleteOne({ _id: taskId }).catch(() => undefined);
      throw error;
    }
  }

  @Get('follow-ups')
  @ApiOperation({ summary: 'Daftar tindak lanjut laporan dengan pagination' })
  async listFollowUps(@Param('reportId') reportId: string, @Query('page') page = '1', @Query('limit') limit = '20', @Req() req: any) {
    await this.getReport(reportId, req.user);
    const p = this.pageNumber(page), l = this.pageSize(limit), filter: any = { reportId };
    if (req.user.role === Role.ANGGOTA_SPI) filter.assigneeId = req.user.sub;
    const [items, total] = await Promise.all([this.followUps.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(), this.followUps.countDocuments(filter)]);
    return { items, page: p, limit: l, total };
  }

  @Get('follow-ups/:followUpId')
  @ApiOperation({ summary: 'Detail tindak lanjut, task, dan bukti' })
  async getFollowUp(@Param('reportId') reportId: string, @Param('followUpId') followUpId: string, @Req() req: any) {
    const row: any = await this.followUps.findOne({ _id: followUpId, reportId }).lean();
    if (!row) throw new NotFoundException('Tindak lanjut tidak ditemukan');
    await this.assertFollowUpActor(reportId, row, req.user);
    return this.followUpDetail(followUpId);
  }

  @Patch('follow-ups/:followUpId')
  @ApiOperation({ summary: 'Mulai tindak lanjut sebagai penanggung jawab' })
  async updateFollowUp(@Param('reportId') reportId: string, @Param('followUpId') followUpId: string, @Body() dto: FollowUpStatusDto, @Req() req: any) {
    const row: any = await this.followUps.findOne({ _id: followUpId, reportId });
    if (!row) throw new NotFoundException('Tindak lanjut tidak ditemukan');
    await this.assertFollowUpActor(reportId, row, req.user);
    if (req.user.role !== Role.ADMIN_SPI && String(row.assigneeId) !== req.user.sub) throw new ForbiddenException('Hanya penanggung jawab yang dapat memperbarui tindak lanjut');
    if (dto.status !== 'IN_PROGRESS' || !canTransitionFollowUpStatus(row.status, 'IN_PROGRESS')) throw new ConflictException('Transisi status tindak lanjut tidak valid');
    const previous = row.status;
    row.status = 'IN_PROGRESS'; await row.save();
    await this.tasks.updateOne({ _id: row.taskId }, { $set: { status: 'IN_PROGRESS' } });
    await this.writeHistory({ reportId, followUpId, taskId: row.taskId, actorId: req.user.sub, action: 'FOLLOW_UP_STARTED', fromStatus: previous, toStatus: 'IN_PROGRESS' });
    return row.toObject();
  }

  @Post('follow-ups/:followUpId/submit-evidence')
  @ApiOperation({ summary: 'Unggah bukti penyelesaian tindak lanjut' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 20971520) }, fileFilter: (_req, file, cb) => cb(null, ['application/pdf', 'image/png', 'image/jpeg'].includes(file.mimetype)) }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, description: { type: 'string', maxLength: 2000 } } } })
  async submitEvidence(@Param('reportId') reportId: string, @Param('followUpId') followUpId: string, @UploadedFile() file: Express.Multer.File, @Body('description') description: string, @Req() req: any) {
    if (!file) throw new BadRequestException('File bukti PDF/JPG/PNG wajib diunggah');
    const row: any = await this.followUps.findOne({ _id: followUpId, reportId });
    if (!row) throw new NotFoundException('Tindak lanjut tidak ditemukan');
    await this.assertFollowUpActor(reportId, row, req.user);
    if (req.user.role !== Role.ADMIN_SPI && String(row.assigneeId) !== req.user.sub) throw new ForbiddenException('Bukti hanya dapat dikirim penanggung jawab tugas');
    if (!canTransitionFollowUpStatus(row.status, 'SUBMITTED')) throw new ConflictException('Status tindak lanjut belum mengizinkan pengiriman bukti');
    const uploaded = await this.files.upload(file.buffer, file.originalname, `/spi/follow-ups/${followUpId}`);
    try {
      const evidence = await this.evidence.create({ followUpId: row._id, taskId: row.taskId, uploadedBy: req.user.sub, description: String(description || '').slice(0, 2000), file: {
        provider: 'imagekit', fileId: uploaded.fileId, fileName: uploaded.name, filePath: uploaded.filePath, url: uploaded.url,
        mimeType: file.mimetype, sizeBytes: file.size, uploadedAt: new Date(), status: 'UPLOADED',
      } });
      const previous = row.status; row.status = 'SUBMITTED'; await row.save();
      await this.tasks.updateOne({ _id: row.taskId }, { $set: { status: 'SUBMITTED' } });
      await this.writeHistory({ reportId, followUpId, taskId: row.taskId, actorId: req.user.sub, action: 'FOLLOW_UP_EVIDENCE_SUBMITTED', fromStatus: previous, toStatus: 'SUBMITTED', metadata: { evidenceId: String(evidence._id) } });
      return evidence;
    } catch (error) {
      await this.files.delete(uploaded.fileId).catch(() => undefined);
      throw error;
    }
  }

  @Post('follow-ups/:followUpId/verify')
  @ApiOperation({ summary: 'Verifikasi bukti dan putuskan status tindak lanjut' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async verifyFollowUp(@Param('reportId') reportId: string, @Param('followUpId') followUpId: string, @Body() dto: FollowUpVerifyDto, @Req() req: any) {
    await this.getReport(reportId, req.user);
    const row: any = await this.followUps.findOne({ _id: followUpId, reportId });
    if (!row) throw new NotFoundException('Tindak lanjut tidak ditemukan');
    if (!canTransitionFollowUpStatus(row.status, 'UNDER_VERIFICATION') || !canTransitionFollowUpStatus('UNDER_VERIFICATION', dto.decision)) throw new ConflictException('Transisi verifikasi tindak lanjut tidak valid');
    const submittedEvidence = await this.evidence.find({ followUpId: row._id, status: 'SUBMITTED' }).lean();
    if (!submittedEvidence.length) throw new ConflictException('Bukti tindak lanjut tidak ditemukan');
    const finalStatus = dto.decision;
    const previous = row.status;
    row.status = 'UNDER_VERIFICATION'; row.verifiedBy = req.user.sub; row.verifiedAt = new Date(); await row.save();
    await this.writeHistory({ reportId, followUpId, taskId: row.taskId, actorId: req.user.sub, action: 'FOLLOW_UP_VERIFICATION_STARTED', fromStatus: previous, toStatus: 'UNDER_VERIFICATION' });
    row.status = finalStatus; await row.save();
    await this.evidence.updateMany({ followUpId: row._id, status: 'SUBMITTED' }, { $set: { status: finalStatus === 'COMPLETED' ? 'ACCEPTED' : 'REJECTED', verifiedBy: req.user.sub, verificationNote: dto.note || '' } });
    await this.tasks.updateOne({ _id: row.taskId }, { $set: { status: finalStatus } });
    await this.writeHistory({ reportId, followUpId, taskId: row.taskId, actorId: req.user.sub, action: 'FOLLOW_UP_VERIFICATION_DECISION', fromStatus: 'UNDER_VERIFICATION', toStatus: finalStatus, note: dto.note || '' });
    return { ...row.toObject(), evidenceCount: submittedEvidence.length };
  }

  @Get('follow-ups/:followUpId/history')
  @ApiOperation({ summary: 'Riwayat perubahan status dan bukti tindak lanjut' })
  async followUpHistory(@Param('reportId') reportId: string, @Param('followUpId') followUpId: string, @Req() req: any) {
    const row: any = await this.followUps.findOne({ _id: followUpId, reportId }).lean();
    if (!row) throw new NotFoundException('Tindak lanjut tidak ditemukan');
    await this.assertFollowUpActor(reportId, row, req.user);
    const [events, evidence] = await Promise.all([this.history.find({ followUpId }).sort({ createdAt: 1 }).lean(), this.evidence.find({ followUpId }).sort({ createdAt: 1 }).lean()]);
    return { events, evidence };
  }

  @Post('close')
  @ApiOperation({ summary: 'Tutup laporan setelah seluruh tindak lanjut terselesaikan' })
  @Roles(Role.PIMPINAN_SPI, Role.ADMIN_SPI)
  async closeReport(@Param('reportId') reportId: string, @Body() dto: DecisionNoteDto, @Req() req: any) {
    const report = await this.getReport(reportId, req.user);
    if (!['APPROVED', 'FOLLOW_UP'].includes(report.status)) throw new ConflictException('Laporan harus disetujui sebelum ditutup');
    const unresolved = await this.followUps.countDocuments({ reportId, status: { $ne: 'COMPLETED' } });
    if (unresolved) throw new ConflictException('Semua tindak lanjut harus selesai sebelum laporan ditutup');
    await this.reports.updateOne({ _id: reportId }, { $set: { status: 'CLOSED', closedAt: new Date(), closedBy: req.user.sub } });
    await this.writeHistory({ reportId, actorId: req.user.sub, action: 'REPORT_CLOSED', fromStatus: report.status, toStatus: 'CLOSED', note: dto?.note || '' });
    return this.reports.findById(reportId).lean();
  }

  private async decideRecommendation(reportId: string, reviewId: string, recommendationId: string, status: string, note: string | undefined, user: any) {
    await this.assertReviewAccess(reportId, reviewId, user);
    if (!await this.reviews.exists({ _id: reviewId, reportId, status: 'COMPLETED' })) throw new ConflictException('Rekomendasi belum tersedia untuk evaluasi manusia');
    if (status === 'APPROVED' && await this.recommendations.exists({ _id: recommendationId, reportId, reviewId, verificationStatus: 'NEEDS_VERIFICATION' })) {
      throw new ConflictException('Rekomendasi harus diverifikasi sebelum disetujui');
    }
    const recommendation = await this.recommendations.findOneAndUpdate({ _id: recommendationId, reportId, reviewId, status: { $in: ['PENDING_REVIEW', 'NEEDS_VERIFICATION'] } }, { $set: { status, reviewedBy: user.sub, reviewedAt: new Date(), reviewNote: note || '' } }, { new: true }).lean();
    if (!recommendation) throw new NotFoundException('Rekomendasi tidak ditemukan atau sudah diputuskan');
    await this.writeHistory({ reportId, actorId: user.sub, action: `RECOMMENDATION_${status}`, toStatus: status, note, metadata: { recommendationId } });
    return recommendation;
  }

  private async finishEvaluation(reportId: string, evaluationId: string, status: string, note: string | undefined, user: any) {
    await this.getReport(reportId, user);
    const evaluation: any = await this.evaluations.findOne({ _id: evaluationId, reportId, status: 'IN_PROGRESS' });
    if (!evaluation) throw new NotFoundException('Evaluasi aktif tidak ditemukan');
    const previous = evaluation.status;
    evaluation.status = status; evaluation.decisionAt = new Date();
    if (note) evaluation.note = `${evaluation.note ? `${evaluation.note}\n` : ''}${note}`.slice(0, 10000);
    await evaluation.save();
    const reportStatus = status === 'APPROVED' ? 'APPROVED' : 'NEEDS_REVISION';
    await this.reports.updateOne({ _id: reportId }, { $set: { status: reportStatus, humanEvaluationId: evaluation._id } });
    if (evaluation.reviewId) await this.reviews.updateOne({ _id: evaluation.reviewId }, { $set: { 'data.humanVerificationStatus': 'VERIFIED' } });
    await this.writeHistory({ reportId, evaluationId, actorId: user.sub, action: `HUMAN_EVALUATION_${status}`, fromStatus: previous, toStatus: status, note: note || '' });
    return evaluation.toObject();
  }

  private async assertReviewAccess(reportId: string, reviewId: string, user: any) {
    await this.getReport(reportId, user);
    if (!await this.reviews.exists({ _id: reviewId, reportId })) throw new NotFoundException('Evaluasi AI tidak ditemukan');
  }

  private async getReport(reportId: string, user: any) {
    const report: any = await this.reports.findById(reportId).lean();
    if (!report) throw new NotFoundException('Laporan tidak ditemukan');
    return report;
  }

  private async assertFollowUpActor(reportId: string, followUp: any, user: any) {
    await this.getReport(reportId, user);
    if (!canAccessFollowUp(user.role, user.sub, followUp.assigneeId)) throw new ForbiddenException('Tindak lanjut bukan tanggung jawab Anda');
  }

  private async followUpDetail(id: any) {
    const [row, evidence]: [any, any[]] = await Promise.all([this.followUps.findById(id).lean(), this.evidence.find({ followUpId: id }).sort({ createdAt: 1 }).lean()]);
    return row ? { ...row, evidence, task: await this.tasks.findById(row.taskId).lean() } : null;
  }

  private getFindings(reviewId: any) { return this.findings.find({ reviewId }).lean(); }
  private pageNumber(value: string) { const page = Number(value); return Number.isInteger(page) && page > 0 ? page : 1; }
  private pageSize(value: string) { const limit = Number(value); return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20; }
  private writeHistory(input: Record<string, any>) { return this.history.create(input); }
}
