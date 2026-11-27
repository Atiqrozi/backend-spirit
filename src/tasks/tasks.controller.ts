import { BadRequestException, Body, Controller, ForbiddenException, Get, Logger, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';
import { User } from '../users/user.schema';
import { Notification } from '../notifications/notification.schema';

class TaskDto {
  @IsString() @MaxLength(500) title: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsMongoId() assigneeId?: string;
  @IsOptional() @IsString() unitId?: string;
  @IsOptional() @IsString() @MaxLength(300) auditee?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() dueDate?: string;
}
class TaskUpdateDto {
  @IsOptional() @IsString() @MaxLength(500) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsMongoId() assigneeId?: string;
  @IsOptional() @IsString() unitId?: string;
  @IsOptional() @IsString() @MaxLength(300) auditee?: string;
  @IsOptional() @IsIn(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) status?: string;
}

@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class TasksController {
  private readonly logger = new Logger(TasksController.name);
  constructor(
    @InjectModel('Task') private readonly tasks: Model<any>,
    @InjectModel('Occurrence') private readonly occurrencesModel: Model<any>,
    @InjectModel('Recurrence') private readonly recurrences: Model<any>,
    @InjectModel(User.name) private readonly users: Model<any>,
    @InjectModel(Notification.name) private readonly notifications: Model<any>,
  ) {}

  @Get('tasks')
  async list(@Query('page') page = '1', @Query('limit') limit = '20', @Query('search') search = '', @Query('status') status = '', @Req() req: any) {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.min(Math.max(1, Number(limit) || 20), 100);
    const accessFilter = req.user.role === Role.ADMIN_SPI || req.user.role === Role.PIMPINAN_SPI
      ? {} : { $or: [{ createdBy: req.user.sub }, { 'data.assigneeId': req.user.sub }] };
    const filter: Record<string, any> = { ...accessFilter };
    if (search.trim()) filter['data.title'] = { $regex: search.trim(), $options: 'i' };
    if (status) filter.$and = [{ $or: [{ status }, { 'data.status': status }] }];
    const [items, total] = await Promise.all([
      this.tasks.find(filter).sort({ createdAt: -1 }).skip((p - 1) * size).limit(size).lean(),
      this.tasks.countDocuments(filter),
    ]);
    const assigneeIds = [...new Set(items.map((item: any) => String(item.data?.assigneeId || '')).filter(Boolean))];
    const assignees = assigneeIds.length ? await this.users.find({ _id: { $in: assigneeIds } }).select('name role unit').lean() : [];
    const assigneeMap = new Map(assignees.map((user: any) => [String(user._id), user]));
    const withAssigneeNames = items.map((item: any) => {
      const user: any = assigneeMap.get(String(item.data?.assigneeId || ''));
      return user ? { ...item, data: { ...item.data, assigneeName: item.data?.assigneeName || user.name, assigneeRole: user.role, assigneeUnit: user.unit } } : item;
    });
    return { items: withAssigneeNames, page: p, limit: size, total };
  }

  @Post('tasks')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async create(@Body() dto: TaskDto, @Req() req: any) {
    const assignee: any = dto.assigneeId ? await this.users.findOne({ _id: dto.assigneeId, active: true }).select('name role').lean() : null;
    if (dto.assigneeId && !assignee) throw new BadRequestException('Penanggung jawab harus merupakan pengguna SPI yang aktif');
    const auditee = dto.auditee?.trim() || dto.unitId?.trim();
    const task: any = await this.tasks.create({ data: {
      ...dto,
      ...(assignee ? { assigneeName: assignee.name, assigneeRole: assignee.role } : {}),
      ...(auditee ? { auditee, unitId: auditee } : {}),
      ...(dto.startDate ? { startDate: new Date(dto.startDate) } : {}),
      ...(dto.dueDate ? { dueDate: new Date(dto.dueDate) } : {}),
    }, createdBy: req.user.sub, status: dto.assigneeId ? 'ASSIGNED' : 'OPEN' });
    if (assignee) await this.notifyNewAssignment(task, String(dto.assigneeId), String(assignee.name || 'Pengguna SPI'));
    return task;
  }

  @Patch('tasks/:id')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async update(@Param('id') id: string, @Body() dto: TaskUpdateDto, @Req() req: any) {
    const task: any = await this.tasks.findById(id);
    if (!task) throw new NotFoundException('Tugas tidak ditemukan');
    if (task.data?.followUp?.followUpId) throw new ForbiddenException('Tugas tindak lanjut harus dikelola melalui endpoint follow-up laporan');
    const allowed = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
    if (dto.status && !allowed.includes(dto.status)) throw new ForbiddenException('Status tugas tidak diizinkan');
    const assignee: any = dto.assigneeId ? await this.users.findOne({ _id: dto.assigneeId, active: true }).select('name role').lean() : null;
    if (dto.assigneeId && !assignee) throw new BadRequestException('Penanggung jawab harus merupakan pengguna SPI yang aktif');
    const patch: Record<string, unknown> = {};
    for (const field of ['title', 'description', 'assigneeId', 'unitId', 'auditee', 'status'] as const) if (dto[field] !== undefined) patch[`data.${field}`] = dto[field];
    if (dto.assigneeId && assignee) { patch['data.assigneeName'] = assignee.name; patch['data.assigneeRole'] = assignee.role; }
    if (dto.auditee !== undefined) patch['data.unitId'] = dto.auditee.trim();
    if (dto.dueDate !== undefined) patch['data.dueDate'] = new Date(dto.dueDate);
    patch.updatedAt = new Date();
    const updated: any = await this.tasks.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    if (dto.assigneeId && String(dto.assigneeId) !== String(task.data?.assigneeId || '') && assignee) {
      await this.notifyNewAssignment(updated, String(dto.assigneeId), String(assignee.name || 'Pengguna SPI'));
    }
    return updated;
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
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
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

  private async notifyNewAssignment(task: any, recipientId: string, recipientName: string) {
    const taskId = String(task._id);
    const title = String(task.data?.title || 'Penugasan SPI');
    const dueDate = task.data?.dueDate ? new Date(task.data.dueDate) : null;
    const dueLabel = dueDate && !Number.isNaN(dueDate.getTime())
      ? ` Tenggat: ${new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long' }).format(dueDate)}.`
      : '';
    const assignmentKey = `task-assignment:${taskId}:${recipientId}:${new Date(task.createdAt || Date.now()).getTime()}`;
    try {
      await this.notifications.updateOne({ dedupeKey: assignmentKey }, { $setOnInsert: {
        recipientId, category: 'TASK_ASSIGNMENT', priority: 'IMPORTANT', title: 'Penugasan baru',
        message: `Anda mendapat penugasan “${title}”.${dueLabel}`,
        resource: { type: 'TASK', id: taskId, route: '/app/tasks' }, readAt: null, dedupeKey: assignmentKey,
      } }, { upsert: true });

      if (dueDate && !Number.isNaN(dueDate.getTime())) {
        const remainingDays = this.calendarDayDifference(new Date(), dueDate);
        // Penugasan baru yang tenggatnya H-3 atau lebih dekat langsung diberi pengingat.
        if (remainingDays <= 3) {
          const dueKey = this.localDateKey(dueDate);
          const deadlineKey = `task-deadline:${taskId}:${dueKey}`;
          const timing = remainingDays < 0 ? `terlewat ${Math.abs(remainingDays)} hari` : remainingDays === 0 ? 'hari ini' : `${remainingDays} hari lagi`;
          await this.notifications.updateOne({ dedupeKey: deadlineKey }, { $setOnInsert: {
            recipientId, category: 'TASK_DEADLINE', priority: 'IMPORTANT', title: 'Pengingat tenggat penugasan',
            message: `Tenggat penugasan “${title}” ${timing} (${new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long' }).format(dueDate)}). Mohon periksa dan selesaikan tugas.`,
            resource: { type: 'TASK', id: taskId, route: '/app/tasks' }, readAt: null, dedupeKey: deadlineKey,
          } }, { upsert: true });
        }
      }
    } catch (error) {
      this.logger.error(`Notifikasi penugasan untuk ${recipientName} gagal dibuat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private calendarDayDifference(from: Date, to: Date) {
    const fromKey = this.localDateKey(from);
    const toKey = this.localDateKey(to);
    const parse = (key: string) => {
      const [year, month, day] = key.split('-').map(Number);
      return Date.UTC(year, month - 1, day);
    };
    return Math.round((parse(toKey) - parse(fromKey)) / 86400000);
  }

  private localDateKey(date: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
}
