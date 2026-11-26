import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';

class TaskDto {
  @IsString() @MaxLength(500) title: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsMongoId() assigneeId?: string;
  @IsOptional() @IsDateString() dueDate?: string;
}
class TaskUpdateDto {
  @IsOptional() @IsString() @MaxLength(500) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsMongoId() assigneeId?: string;
  @IsOptional() @IsIn(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) status?: string;
}

@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class TasksController {
  constructor(
    @InjectModel('Task') private readonly tasks: Model<any>,
    @InjectModel('Occurrence') private readonly occurrencesModel: Model<any>,
    @InjectModel('Recurrence') private readonly recurrences: Model<any>,
  ) {}

  @Get('tasks')
  async list(@Query('page') page = '1', @Req() req: any) {
    const p = Number(page) > 0 ? Number(page) : 1;
    const filter = req.user.role === Role.ADMIN_SPI || req.user.role === Role.PIMPINAN_SPI
      ? {} : { $or: [{ createdBy: req.user.sub }, { 'data.assigneeId': req.user.sub }] };
    return this.tasks.find(filter).sort({ createdAt: -1 }).skip((p - 1) * 20).limit(100).lean();
  }

  @Post('tasks')
  @Roles(Role.ADMIN_SPI, Role.ANGGOTA_SPI)
  create(@Body() dto: TaskDto, @Req() req: any) {
    return this.tasks.create({ data: { ...dto, ...(dto.dueDate ? { dueDate: new Date(dto.dueDate) } : {}) }, createdBy: req.user.sub, status: dto.assigneeId ? 'ASSIGNED' : 'OPEN' });
  }

  @Patch('tasks/:id')
  async update(@Param('id') id: string, @Body() dto: TaskUpdateDto, @Req() req: any) {
    const task: any = await this.tasks.findById(id);
    if (!task) throw new NotFoundException('Tugas tidak ditemukan');
    if (task.data?.followUp?.followUpId) throw new ForbiddenException('Tugas tindak lanjut harus dikelola melalui endpoint follow-up laporan');
    if (![Role.ADMIN_SPI, Role.PIMPINAN_SPI].includes(req.user.role) && task.createdBy !== req.user.sub && task.data?.assigneeId !== req.user.sub) throw new ForbiddenException('Tidak memiliki akses ke tugas ini');
    if (dto.assigneeId !== undefined && ![Role.ADMIN_SPI, Role.PIMPINAN_SPI].includes(req.user.role)) throw new ForbiddenException('Hanya admin atau pimpinan yang dapat mengubah penanggung jawab');
    const allowed = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
    if (dto.status && !allowed.includes(dto.status)) throw new ForbiddenException('Status tugas tidak diizinkan');
    const patch: Record<string, unknown> = {};
    for (const field of ['title', 'description', 'assigneeId', 'status'] as const) if (dto[field] !== undefined) patch[`data.${field}`] = dto[field];
    if (dto.dueDate !== undefined) patch['data.dueDate'] = new Date(dto.dueDate);
    patch.updatedAt = new Date();
    return this.tasks.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
  }

  @Post('tasks/:id/recurrence')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async recurrence(@Param('id') id: string, @Body() dto: any) {
    if (!await this.tasks.exists({ _id: id })) throw new NotFoundException('Tugas tidak ditemukan');
    return this.recurrences.create({ taskId: id, data: { ...dto, timezone: dto.timezone || 'Asia/Jakarta' } });
  }

  @Get('tasks/:id/occurrences')
  async occurrences(@Param('id') id: string, @Req() req: any) {
    await this.assertTaskAccess(id, req.user);
    return this.occurrencesModel.find({ taskId: id }).sort({ dueAt: 1 }).limit(100).lean();
  }

  @Patch('occurrences/:id/status')
  async updateOccurrence(@Param('id') id: string, @Body() body: { status?: string }, @Req() req: any) {
    const occurrence: any = await this.occurrencesModel.findById(id).lean();
    if (!occurrence) throw new NotFoundException('Occurrence tidak ditemukan');
    const task: any = await this.assertTaskAccess(String(occurrence.taskId), req.user);
    if (task.data?.followUp?.followUpId) throw new ForbiddenException('Occurrence follow-up harus dikelola melalui endpoint follow-up laporan');
    if (!['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(body.status)) throw new ForbiddenException('Status occurrence tidak valid');
    return this.occurrencesModel.findByIdAndUpdate(id, { $set: { status: body.status, updatedAt: new Date() } }, { new: true }).lean();
  }

  private async assertTaskAccess(id: string, user: any) {
    const task: any = await this.tasks.findById(id).lean();
    if (!task) throw new NotFoundException('Tugas tidak ditemukan');
    if (![Role.ADMIN_SPI, Role.PIMPINAN_SPI].includes(user.role) && task.createdBy !== user.sub && task.data?.assigneeId !== user.sub) throw new ForbiddenException('Tidak memiliki akses ke tugas ini');
    return task;
  }
}
