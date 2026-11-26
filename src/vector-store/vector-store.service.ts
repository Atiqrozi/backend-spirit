import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NvidiaService } from '../integrations/nvidia/nvidia.service';
import { NvidiaRerankClient } from '../integrations/retrieval/nvidia-rerank.client';
import { VectorChunk } from './vector-chunk.schema';

interface ChunkInput {
  chunkId: string; text: string; pageStart: number; pageEnd: number;
  section?: string; ordinal: number;
}
interface EmbeddingResponse { data?: Array<{ index: number; embedding: number[] }>; model?: string; }

@Injectable()
export class VectorStoreService {
  constructor(
    @InjectModel(VectorChunk.name) private readonly chunks: Model<VectorChunk>,
    private readonly nvidia: NvidiaService,
    private readonly reranker: NvidiaRerankClient,
  ) {}

  async indexChunks(input: { documentId: string; documentVersionId: string; chunks: ChunkInput[] }, userId: string, vectorStatus = 'ACTIVE') {
    if (!input.chunks?.length) throw new BadRequestException('Minimal satu chunk wajib dikirim');
    if (input.chunks.length > 256) throw new BadRequestException('Maksimal 256 chunk per request');
    const model = process.env.CHAT_AI_EMBEDDING_MODEL || process.env.NVIDIA_EMBEDDING_MODEL || 'nvidia/nemotron-3.5-embed-1b';
    const expectedDimensions = Number(process.env.NVIDIA_EMBEDDING_DIMENSIONS || 2048);
    let indexedCount = 0;

    // Batch bounded to avoid oversized NVIDIA requests and keep retries manageable.
    for (let offset = 0; offset < input.chunks.length; offset += 16) {
      const batch = input.chunks.slice(offset, offset + 16);
      let response: EmbeddingResponse;
      try { response = await this.nvidia.embed(batch.map((chunk) => chunk.text), 'passage') as EmbeddingResponse; }
      catch (error) { throw error; }
      if (!response.data || response.data.length !== batch.length) throw new BadGatewayException('Respons embedding NVIDIA tidak cocok dengan jumlah passage');

      const operations = response.data.map((entry) => {
        const source = batch[entry.index];
        if (!source || !Array.isArray(entry.embedding) || entry.embedding.length !== expectedDimensions) {
          throw new BadGatewayException(`Dimensi embedding tidak sesuai konfigurasi (${expectedDimensions})`);
        }
        if (!source.chunkId || !source.text || source.pageStart < 1 || source.pageEnd < source.pageStart) {
          throw new BadRequestException('Metadata chunk tidak lengkap atau rentang halaman tidak valid');
        }
        return {
          updateOne: {
            filter: { documentVersionId: input.documentVersionId, chunkId: source.chunkId },
            update: { $set: {
              documentId: input.documentId, documentVersionId: input.documentVersionId,
              chunkId: source.chunkId, text: source.text, embedding: entry.embedding,
              embeddingModel: response.model || model, ordinal: source.ordinal,
              pageStart: source.pageStart, pageEnd: source.pageEnd, section: source.section,
              status: vectorStatus, indexedBy: userId,
            } },
            upsert: true,
          },
        };
      });
      await this.chunks.bulkWrite(operations, { ordered: true });
      indexedCount += operations.length;
    }

    return { status: 'INDEXED', documentId: input.documentId, documentVersionId: input.documentVersionId, indexedCount, skippedCount: 0, embeddingModel: model };
  }

  async setVersionStatus(documentVersionId: string, status: string) {
    return this.chunks.updateMany({ documentVersionId }, { $set: { status } });
  }

  countVersionChunks(documentId: string, documentVersionId: string) {
    return this.chunks.countDocuments({ documentId, documentVersionId }).exec();
  }

  async archiveOtherVersions(documentId: string, activeVersionId: string) {
    return this.chunks.updateMany({ documentId, documentVersionId: { $ne: activeVersionId } }, { $set: { status: 'ARCHIVED' } });
  }

  async removeObsoleteVersionChunks(documentVersionId: string, retainedChunkIds: string[]) {
    return this.chunks.deleteMany({ documentVersionId, chunkId: { $nin: retainedChunkIds } });
  }

  async search(input: { query: string; filters?: { documentIds?: string[]; documentVersionIds?: string[] }; topK?: number; rerank?: boolean; rerankTopN?: number }) {
    if (!input.query?.trim()) throw new BadRequestException('query wajib diisi');
    const topK = Math.min(Math.max(Number(input.topK || 20), 1), 100);
    const rerank = input.rerank !== false;
    const rerankTopN = Math.min(Math.max(Number(input.rerankTopN || Math.min(topK, 20)), 1), 50);
    const model = process.env.CHAT_AI_EMBEDDING_MODEL || process.env.NVIDIA_EMBEDDING_MODEL || 'nvidia/nemotron-3.5-embed-1b';
    const dimensions = Number(process.env.NVIDIA_EMBEDDING_DIMENSIONS || 2048);

    const result = await this.nvidia.embed([input.query], 'query') as EmbeddingResponse;
    const queryVector = result.data?.[0]?.embedding;
    if (!queryVector || queryVector.length !== dimensions) throw new BadGatewayException(`Embedding query tidak sesuai dimensi index (${dimensions})`);
    const indexName = process.env.MONGODB_VECTOR_INDEX_NAME || 'spi_chunks_vector_idx';
    const filter: Record<string, unknown> = { status: 'ACTIVE' };
    if (input.filters?.documentIds?.length) filter.documentId = { $in: input.filters.documentIds };
    if (input.filters?.documentVersionIds?.length) filter.documentVersionId = { $in: input.filters.documentVersionIds };

    let candidates: any[];
    try {
      candidates = await this.chunks.aggregate([
        { $vectorSearch: { index: indexName, path: 'embedding', queryVector, numCandidates: Math.min(1000, Math.max(topK * 20, 100)), limit: topK, filter } },
        // Inclusion projection: omitting embedding keeps the large vector out of the result.
        { $project: { _id: 0, documentId: 1, documentVersionId: 1, chunkId: 1, text: 1, pageStart: 1, pageEnd: 1, section: 1, embeddingModel: 1, retrievalScore: { $meta: 'vectorSearchScore' } } },
      ]).exec();
    } catch (error) {
      if (String(error?.message || '').toLowerCase().includes('index')) throw new ServiceUnavailableException(`Vector Search index '${indexName}' belum tersedia di MongoDB Atlas`);
      throw error;
    }

    if (!rerank || !candidates.length) return { query: input.query, sources: candidates.slice(0, topK), count: candidates.length, embeddingModel: model, rerankModel: null };
    if (!process.env.NVIDIA_API_KEY && !process.env.CHAT_AI_API_KEY) throw new ServiceUnavailableException('NVIDIA_API_KEY belum dikonfigurasi untuk reranking');
    const rerankCount = Math.min(candidates.length, rerankTopN, 50);
    const ranked = await this.reranker.rerank(input.query, candidates.slice(0, rerankCount).map((item) => ({ text: item.text })));
    const reranked = ranked.passages.map((item: any) => ({ ...candidates[item.index], rerankScore: item.score }));
    const sources = [...reranked, ...candidates.slice(rerankCount)].slice(0, topK);
    return { query: input.query, sources, count: sources.length, embeddingModel: model, rerankModel: process.env.NVIDIA_RERANK_MODEL || 'nvidia/nemotron-3.5-rerank-8b' };
  }
}
