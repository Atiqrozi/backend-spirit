import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';
import * as nodemailer from 'nodemailer';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    @InjectModel('Notification') private readonly notifications: Model<any>,
    @InjectModel('NotificationLog') private readonly logsModel: Model<any>,
    @InjectModel('NotificationPreference') private readonly preferences: Model<any>,
  ) {}

  @Get()
  async list(@Query('page') page = '1', @Query('limit') limit = '20', @Query('status') status = '', @Query('category') category = '', @Req() req: any) {
    const currentPage = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(Math.max(1, Number(limit) || 20), 100);
    const filter: Record<string, any> = { recipientId: String(req.user.sub) };
    if (status === 'UNREAD') filter.readAt = null;
    if (status === 'READ') filter.readAt = { $ne: null };
    if (category.trim()) filter.category = category.trim();
    const [items, total, unreadCount] = await Promise.all([
      this.notifications.find(filter).sort({ createdAt: -1 }).skip((currentPage - 1) * pageSize).limit(pageSize).lean(),
      this.notifications.countDocuments(filter),
      this.notifications.countDocuments({ recipientId: String(req.user.sub), readAt: null }),
    ]);
    return { items, page: currentPage, limit: pageSize, total, unreadCount };
  }

  @Get('unread-count')
  async unreadCount(@Req() req: any) {
    const count = await this.notifications.countDocuments({ recipientId: String(req.user.sub), readAt: null });
    return { count };
  }

  @Patch('read-all')
  async readAll(@Req() req: any) {
    const result = await this.notifications.updateMany(
      { recipientId: String(req.user.sub), readAt: null },
      { $set: { readAt: new Date() } },
    );
    const unreadCount = await this.notifications.countDocuments({ recipientId: String(req.user.sub), readAt: null });
    return { updatedCount: result.modifiedCount, unreadCount };
  }

  @Get('preferences')
  async getPreferences(@Req() req: any) {
    const userId = String(req.user.sub);
    return await this.preferences.findOne({ userId }).lean() || { userId, timezone: 'Asia/Jakarta', categories: {} };
  }

  @Patch('preferences')
  async updatePreferences(@Body() body: any, @Req() req: any) {
    const userId = String(req.user.sub);
    const patch: Record<string, any> = {};
    if (typeof body.timezone === 'string') patch.timezone = body.timezone;
    if (body.categories && typeof body.categories === 'object') patch.categories = body.categories;
    return this.preferences.findOneAndUpdate({ userId }, { $set: patch, $setOnInsert: { userId } }, { new: true, upsert: true }).lean();
  }

  @Get('logs')
  @Roles(Role.ADMIN_SPI)
  logs() { return this.logsModel.find().sort({ createdAt: -1 }).limit(100).lean(); }

  @Post('test-email')
  @Roles(Role.ADMIN_SPI)
  async test(@Body() body: any) {
    if (!process.env.SMTP_HOST) return { sent: false, message: 'SMTP belum dikonfigurasi' };
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined });
    try {
      await transporter.sendMail({ from: process.env.SMTP_FROM, to: body.email, subject: 'Uji email SPI', text: 'Konfigurasi email SPI berfungsi.' });
      return this.logsModel.create({ data: { recipient: body.email, channel: 'EMAIL', type: 'TEST' }, status: 'SENT', sentAt: new Date() });
    } catch {
      return this.logsModel.create({ data: { recipient: body.email, channel: 'EMAIL', type: 'TEST', error: 'Pengiriman gagal' }, status: 'FAILED' });
    }
  }

  @Get(':id')
  async getOne(@Param('id') id: string, @Req() req: any) {
    const item = await this.notifications.findOne({ _id: id, recipientId: String(req.user.sub) }).lean();
    if (!item) throw new NotFoundException('Notifikasi tidak ditemukan');
    return item;
  }

  @Patch(':id/read')
  async markRead(@Param('id') id: string, @Req() req: any) {
    const item = await this.notifications.findOneAndUpdate(
      { _id: id, recipientId: String(req.user.sub) },
      { $set: { readAt: new Date() } },
      { new: true },
    ).lean();
    if (!item) throw new NotFoundException('Notifikasi tidak ditemukan');
    return item;
  }
}
