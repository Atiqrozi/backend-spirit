import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'document_chunk_vectors', timestamps: true })
export class VectorChunk {
  @Prop({ required: true, index: true }) documentId: string;
  @Prop({ required: true, index: true }) documentVersionId: string;
  @Prop({ required: true }) chunkId: string;
  @Prop({ required: true }) text: string;
  @Prop({ type: [Number], required: true, select: false }) embedding: number[];
  @Prop({ required: true }) embeddingModel: string;
  @Prop({ required: true, default: 0 }) ordinal: number;
  @Prop({ required: true }) pageStart: number;
  @Prop({ required: true }) pageEnd: number;
  @Prop() section?: string;
  @Prop({ required: true, default: 'ACTIVE', index: true }) status: string;
  @Prop() indexedBy?: string;
}

export type VectorChunkDocument = HydratedDocument<VectorChunk>;
export const VectorChunkSchema = SchemaFactory.createForClass(VectorChunk);
VectorChunkSchema.index({ documentVersionId: 1, chunkId: 1 }, { unique: true });
