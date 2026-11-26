import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { NvidiaService } from '../integrations/nvidia/nvidia.service';
import { NvidiaRerankClient } from '../integrations/retrieval/nvidia-rerank.client';
import { VectorChunk, VectorChunkSchema } from './vector-chunk.schema';
import { VectorStoreController } from './vector-store.controller';
import { VectorStoreService } from './vector-store.service';

@Module({
  imports: [JwtModule.register({}), MongooseModule.forFeature([{ name: VectorChunk.name, schema: VectorChunkSchema, collection: process.env.MONGODB_VECTOR_COLLECTION || 'document_chunk_vectors' }])],
  controllers: [VectorStoreController],
  providers: [VectorStoreService, NvidiaService, NvidiaRerankClient],
  exports: [VectorStoreService, NvidiaService],
})
export class VectorStoreModule {}
