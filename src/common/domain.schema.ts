import { Schema } from 'mongoose';
export const DomainSchema = new Schema({ data: { type: Schema.Types.Mixed, default: {} }, createdBy: String, status: { type: String, default: 'ACTIVE', index: true }, version: { type: Number, default: 1 }, createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now } }, { strict: false, collection: undefined });
