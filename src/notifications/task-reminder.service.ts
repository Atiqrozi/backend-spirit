import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Notification } from './notification.schema';

@Injectable()
export class TaskReminderService {
  private readonly logger = new Logger(TaskReminderService.name);
  private readonly timezone = 'Asia/Jakarta';

  constructor(
    @InjectModel('Task') private readonly tasks: Model<any>,
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
  ) {}

  // Jadwal pukul 08.15 WIB. H-2 yang jatuh pada akhir pekan dimajukan ke Jumat.
  @Cron('15 8 * * *', { timeZone: 'Asia/Jakarta' })
  async remindAssignedUsers() {
    const now = new Date();
    const today = this.localDateParts(now);
    const todayKey = this.dateKey(today.year, today.month, today.day);
    const todayWeekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();

    // Setiap hari cek H-2. Pada Jumat, cek juga tenggat Senin dan Selasa karena H-2-nya akhir pekan.
    const offsets = todayWeekday === 5 ? [2, 3, 4] : [2];
    const dueDateRanges = offsets.map((offset) => {
      const start = new Date(Date.UTC(today.year, today.month - 1, today.day + offset) - 7 * 60 * 60 * 1000);
      return { 'data.dueDate': { $gte: start, $lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) } };
    });

    const tasks = await this.tasks.find({
      'data.assigneeId': { $exists: true, $ne: '' },
      $or: dueDateRanges,
      status: { $nin: ['COMPLETED', 'CANCELLED'] },
      'data.status': { $nin: ['COMPLETED', 'CANCELLED'] },
    }).select('_id data').lean();

    let created = 0;
    for (const task of tasks) {
      const assigneeId = String(task.data?.assigneeId || '');
      const dueDate = task.data?.dueDate ? new Date(task.data.dueDate) : null;
      if (!assigneeId || !dueDate || Number.isNaN(dueDate.getTime())) continue;

      const due = this.localDateParts(dueDate);
      const dueKey = this.dateKey(due.year, due.month, due.day);
      const reminderDate = new Date(Date.UTC(due.year, due.month - 1, due.day - 2));
      const reminderWeekday = reminderDate.getUTCDay();
      if (reminderWeekday === 6) reminderDate.setUTCDate(reminderDate.getUTCDate() - 1);
      if (reminderWeekday === 0) reminderDate.setUTCDate(reminderDate.getUTCDate() - 2);
      const reminderKey = this.dateKey(reminderDate.getUTCFullYear(), reminderDate.getUTCMonth() + 1, reminderDate.getUTCDate());
      if (reminderKey !== todayKey) continue;

      const title = String(task.data?.title || 'Penugasan SPI');
      const formattedDate = new Intl.DateTimeFormat('id-ID', {
        timeZone: this.timezone, day: '2-digit', month: 'long', year: 'numeric',
      }).format(dueDate);
      const dedupeKey = `task-deadline:${task._id}:${dueKey}`;
      const result = await this.notifications.updateOne(
        { dedupeKey },
        { $setOnInsert: {
          recipientId: assigneeId,
          category: 'TASK_DEADLINE',
          priority: 'IMPORTANT',
          title: 'Pengingat tenggat penugasan',
          message: `Penugasan “${title}” akan jatuh tempo pada ${formattedDate}. Mohon periksa dan selesaikan tugas sebelum tenggat.`,
          resource: { type: 'TASK', id: String(task._id), route: '/app/tasks' },
          readAt: null,
          dedupeKey,
        } },
        { upsert: true },
      );
      if (result.upsertedCount) created++;
    }

    this.logger.log(`Pengingat tenggat: ${created} notifikasi dibuat dari ${tasks.length} tugas yang diperiksa.`);
  }

  private localDateParts(date: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  private dateKey(year: number, month: number, day: number) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
}
