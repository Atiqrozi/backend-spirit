import { Injectable, BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
@Injectable() export class NvidiaService {
 private async call(url: string, body: any) {
  const key = process.env.NVIDIA_API_KEY || process.env.CHAT_AI_API_KEY;
  if (!key) throw new ServiceUnavailableException('NVIDIA API belum dikonfigurasi');
  const timeoutMs = Math.max(Number(process.env.NVIDIA_REQUEST_TIMEOUT_MS || 240000), 10000);
  try {
   const response = await fetch(url, { method:'POST', headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(timeoutMs) });
   if (!response.ok) throw new BadGatewayException(`NVIDIA API gagal (${response.status})`);
   return response.json();
  } catch (error) {
   if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    throw new BadGatewayException(`NVIDIA API tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik; job dapat dicoba ulang`);
   }
   throw error;
  }
 }
 ocr(imageDataUrl: string) { return this.call(process.env.NVIDIA_OCR_ENDPOINT, { input:[{ type:'image_url', url:imageDataUrl }], merge_levels:['paragraph'] }); }
 review(report: string, template: unknown, sources: unknown[]) { return this.call(process.env.CHAT_AI_ENDPOINT || process.env.NVIDIA_CHAT_ENDPOINT, { model:process.env.CHAT_AI_MODEL || process.env.NVIDIA_CHAT_MODEL, temperature:0.1, messages:[{role:'system',content:'Kamu memberi rekomendasi audit kepatuhan, bukan keputusan hukum atau approval. Balas hanya JSON valid dengan bentuk {"summary":string,"limitations":string[],"regulationAssessments":[{"documentId":"string","documentVersionId":"string","status":"COMPLIANT|NON_COMPLIANT|PARTIALLY_COMPLIANT|NOT_ASSESSABLE","summary":"string","sourceChunkIds":["string"]}],"findings":[{"title":"string","description":"string","priority":"LOW|MEDIUM|HIGH|CRITICAL","complianceStatus":"COMPLIANT|NON_COMPLIANT|PARTIALLY_COMPLIANT|NOT_ASSESSABLE","reasoning":"string","suggestion":"string","confidence":number|null,"sourceChunkIds":["string"],"reportEvidence":[{"pageNumber":number,"quote":"string"}]}],"reportRecommendations":[{"title":"string","description":"string","rationale":"string","action":"string","priority":"LOW|MEDIUM|HIGH|CRITICAL","sourceChunkIds":["string"],"reportEvidence":[{"pageNumber":number,"quote":"string"}]}],"inspectionRecommendations":[{"title":"string","description":"string","rationale":"string","action":"string","priority":"LOW|MEDIUM|HIGH|CRITICAL","sourceChunkIds":["string"],"reportEvidence":[{"pageNumber":number,"quote":"string"}],"needsVerification":boolean}]}. Hanya pakai pasangan documentId+documentVersionId dan sourceChunkId yang benar-benar ada pada sumber retrieval. Halaman dan kutipan bukti laporan harus benar-benar muncul pada teks laporan; jangan mengarang. Untuk rekomendasi inspeksi, jangan menganggap kegiatan tidak dilakukan hanya karena tidak ditulis; bila bukti tidak cukup isi needsVerification=true. Pakai status NOT_ASSESSABLE bila sumber/bukti tidak cukup. Tidak boleh membuat nama dokumen, pasal, halaman, atau kutipan regulasi baru.'},{role:'user',content:JSON.stringify({report,template,sources})}] }); }
 embed(input: string[], inputType: 'passage' | 'query' = 'passage') { return this.call(process.env.CHAT_AI_EMBEDDING_ENDPOINT || process.env.NVIDIA_EMBEDDING_ENDPOINT, { model:process.env.CHAT_AI_EMBEDDING_MODEL || process.env.NVIDIA_EMBEDDING_MODEL, input, input_type:inputType, encoding_format:'float', truncate:'END' }); }
}
