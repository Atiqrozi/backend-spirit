import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: true, collection: 'notifications' })
export class Notification {
  @Prop({ required: true, index: true }) recipientId: string;
  @Prop({ required: true, index: true }) category: string;
  @Prop({ default: 'NORMAL', enum: ['NORMAL', 'IMPORTANT'] }) priority: string;
  @Prop({ required: true }) title: string;
  @Prop({ required: true }) message: string;
  @Prop({ type: MongooseSchema.Types.Mixed }) resource?: { type: string; id: string; route: string };
  @Prop({ default: null }) readAt: Date | null;
  @Prop() dedupeKey?: string;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
NotificationSchema.index({ recipientId: 1, createdAt: -1 });
