import { Schema } from 'mongoose';

export const MemoSchema = new Schema({
  memoNumber: { type: String, required: true, trim: true, index: true },
  recipient: { type: String, required: true, trim: true },
  cc: { type: [String], default: [] },
  fromUnit: { type: String, required: true, trim: true },
  subject: { type: String, required: true, trim: true },
  memoDate: { type: Date, required: true },
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  reportReviewId: { type: Schema.Types.ObjectId, required: true, index: true },
  status: { type: String, enum: ['DRAFT', 'SENT_TO_SHEYLA', 'SENT_TO_DIRECTOR', 'DISPOSITION_RECEIVED'], default: 'DRAFT', index: true },
  dispositionVersionId: { type: Schema.Types.ObjectId, default: null },
  dispositionReviewId: { type: Schema.Types.ObjectId, default: null },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  statusHistory: { type: [Schema.Types.Mixed], default: [] },
}, { timestamps: true, versionKey: false, collection: 'memos' });

MemoSchema.index({ memoNumber: 1 }, { unique: true });
MemoSchema.index({ createdAt: -1 });
