import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(
    @InjectModel('Report') private readonly reports: Model<any>,
    @InjectModel('Task') private readonly tasks: Model<any>,
    @InjectModel('Document') private readonly docs: Model<any>,
    @InjectModel('Notification') private readonly notifications: Model<any>,
  ) {}

  @Get('summary')
  async summary(@Req() req: any) {
    const userId = String(req.user.sub);
    const [reports, tasks, documents, notifications, taskRows] = await Promise.all([
      this.reports.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      this.tasks.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      this.docs.countDocuments(),
      this.notifications.find({ recipientId: userId }).sort({ createdAt: -1 }).limit(5).lean(),
      this.tasks.find({
        'data.assigneeId': userId,
        status: { $nin: ['COMPLETED', 'CANCELLED'] },
        'data.status': { $nin: ['COMPLETED', 'CANCELLED'] },
        'data.dueDate': { $exists: true, $ne: null },
      }).sort({ 'data.dueDate': 1 }).limit(5).select('_id data.title data.dueDate status').lean(),
    ]);
    const upcomingDeadlines = taskRows.map((task: any) => ({
      taskId: String(task._id),
      title: String(task.data?.title || 'Penugasan SPI'),
      dueAt: task.data?.dueDate,
      status: task.data?.status || task.status || 'ASSIGNED',
      resourceRoute: '/app/tasks',
    }));
    return { reports, tasks, referenceDocuments: documents, notifications, upcomingDeadlines };
  }
}
