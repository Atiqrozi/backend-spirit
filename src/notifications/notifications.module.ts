import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Schema } from 'mongoose';
import { DomainSchema } from '../common/domain.schema';
import { TaskReminderService } from './task-reminder.service';
import { NotificationsController } from './notifications.controller';
import { Notification, NotificationSchema } from './notification.schema';

const PreferenceSchema = new Schema({ userId: { type: String, required: true, unique: true, index: true }, timezone: { type: String, default: 'Asia/Jakarta' }, categories: { type: Schema.Types.Mixed, default: {} } }, { timestamps: true, collection: 'notification_preferences' });

@Module({
  imports: [MongooseModule.forFeature([
    { name: Notification.name, schema: NotificationSchema },
    { name: 'NotificationLog', schema: DomainSchema, collection: 'notification_logs' },
    { name: 'NotificationPreference', schema: PreferenceSchema, collection: 'notification_preferences' },
    { name: 'Task', schema: DomainSchema, collection: 'tasks' },
  ])],
  controllers: [NotificationsController],
  providers: [TaskReminderService],
})
export class NotificationsModule {}
