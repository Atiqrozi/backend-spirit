import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Notification } from './notification.schema';

@Injectable()
export class TaskReminderService implements OnModuleInit {
  private readonly logger = new Logger(TaskReminderService.name);
  private readonly timezone = 'Asia/Jakarta';

  constructor(
    @InjectModel('Task') private readonly tasks: Model<any>,
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
  ) {}

  async onModuleInit() {
    // Jalankan catch-up saat backend menyala supaya reminder yang terlewat segera dibuat.
    try {
      await this.remindAssignedUsers();
    } catch (error) {
      this.logger.error(`Pemeriksaan awal pengingat tenggat gagal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Periksa berkala pada jam kerja agar tugas yang dibuat setelah pukul 08.15 tidak terlewat.
  // H-2 yang jatuh pada akhir pekan dimajukan ke Jumat.
  @Cron('*/15 8-9 * * 1-5', { timeZone: 'Asia/Jakarta' })
  async remindAssignedUsers() {
    const now = new Date();
    const today = this.localDateParts(now);
    const todayKey = this.dateKey(today.year, today.month, today.day);
    // Ambil jendela tenggat yang cukup lebar untuk catch-up setelah service sempat mati.
    // H-2 weekend dimajukan ke Jumat; tenggat lampau hanya diproses sekali berkat dedupeKey.
    const rangeStart = new Date(Date.UTC(today.year, today.month - 1, today.day - 7) - 7 * 60 * 60 * 1000);
    const rangeEnd = new Date(Date.UTC(today.year, today.month - 1, today.day + 5) - 7 * 60 * 60 * 1000);

    const tasks = await this.tasks.find({
      'data.assigneeId': { $exists: true, $ne: '' },
      'data.dueDate': { $gte: rangeStart, $lt: rangeEnd },
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
      // Catch up jika service baru aktif setelah jadwal reminder hari itu.
      if (reminderKey > todayKey) continue;

      const title = String(task.data?.title || 'Penugasan SPI');
      const formattedDate = new Intl.DateTimeFormat('id-ID', {
        timeZone: this.timezone, day: '2-digit', month: 'long', year: 'numeric',
      }).format(dueDate);
      const deadlineMessage = dueKey < todayKey
        ? `Tenggat penugasan “${title}” telah lewat (${formattedDate}). Mohon periksa status tugas.`
        : `Penugasan “${title}” akan jatuh tempo pada ${formattedDate}. Mohon periksa dan selesaikan tugas sebelum tenggat.`;
      const dedupeKey = `task-deadline:${task._id}:${dueKey}`;
      const result = await this.notifications.updateOne(
        { dedupeKey },
        { $setOnInsert: {
          recipientId: assigneeId,
          category: 'TASK_DEADLINE',
          priority: 'IMPORTANT',
          title: 'Pengingat tenggat penugasan',
          message: deadlineMessage,
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
