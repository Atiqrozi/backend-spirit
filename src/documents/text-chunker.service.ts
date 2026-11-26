import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

export interface ExtractedPage { pageNumber: number; text: string; status: string; }

@Injectable()
export class TextChunkerService {
  createChunks(documentId: string, documentVersionId: string, pages: ExtractedPage[]) {
    const maxWords = Math.max(100, Number(process.env.DOCUMENT_CHUNK_MAX_WORDS) || 450);
    const overlapWords = Math.max(0, Math.min(Number(process.env.DOCUMENT_CHUNK_OVERLAP_WORDS) || 70, maxWords - 1));
    const chunks: Array<{ chunkId: string; text: string; pageStart: number; pageEnd: number; ordinal: number }> = [];
    let ordinal = 0;
    for (const page of pages) {
      const words = page.text.trim().split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      const step = Math.max(1, maxWords - overlapWords);
      for (let start = 0; start < words.length; start += step) {
        const text = words.slice(start, start + maxWords).join(' ').trim();
        if (!text) continue;
        const digest = createHash('sha256').update(`${documentVersionId}:${page.pageNumber}:${ordinal}:${text}`).digest('hex');
        chunks.push({ chunkId: `sha256:${digest}`, text, pageStart: page.pageNumber, pageEnd: page.pageNumber, ordinal: ordinal++ });
        if (start + maxWords >= words.length) break;
      }
    }
    return { documentId, documentVersionId, chunks };
  }
}
