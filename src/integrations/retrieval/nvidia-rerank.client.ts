import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';

export interface RerankPassage {
  text?: string;
  image?: string;
  [metadata: string]: unknown;
}

@Injectable()
export class NvidiaRerankClient {
  async rerank(query: string, passages: RerankPassage[], timeoutOverride?: number) {
    const apiKey = process.env.NVIDIA_API_KEY || process.env.CHAT_AI_API_KEY;
    if (!apiKey) throw new ServiceUnavailableException('NVIDIA_API_KEY belum dikonfigurasi');
    if (!passages?.length) return { rankings: [], passages: [] };

    const endpoint = process.env.NVIDIA_RERANK_ENDPOINT || 'https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-rerank-8b/reranking';
    const timeoutMs = Math.max(Number(timeoutOverride || process.env.NVIDIA_RERANK_TIMEOUT_MS || 90000), 10000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: process.env.NVIDIA_RERANK_MODEL || 'nvidia/nemotron-3.5-rerank-8b', query: { text: query }, passages, truncate: 'END' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new BadGatewayException(`NVIDIA reranking API tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik`);
      }
      throw error;
    }
    if (!response.ok) throw new BadGatewayException(`NVIDIA reranking API gagal (${response.status})`);

    const result = await response.json() as { rankings?: Array<{ index: number; logit: number }> };
    const rankings = [...(result.rankings || [])].sort((a, b) => b.logit - a.logit);
    return { rankings, passages: rankings.map((rank) => ({ ...passages[rank.index], index: rank.index, score: rank.logit })) };
  }
}
