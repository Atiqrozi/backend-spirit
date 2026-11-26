# Kontrak API Chunking dan Retrieval SPI v1

Kontrak ini memisahkan tanggung jawab layanan agar embedding tidak dibuat dua kali.

## Arsitektur dan kepemilikan

Backend NestJS SPI menangani indexing, vector search, dan reranking langsung melalui MongoDB Atlas. Worker dokumen saat ini memakai `TextChunkerService` lokal, yang hanya membagi teks per halaman dan tidak membuat embedding. Route chunking di bawah adalah kontrak opsional bila kelak chunker dipisah menjadi layanan eksternal; worker default tidak memanggilnya. Backend memiliki adapter NVIDIA untuk embedding/OCR/reranking:

1. Worker memecah teks hasil ekstraksi menjadi passage lewat chunking lokal. Jika dideploy sebagai layanan terpisah, `POST /api/v1/chunking/chunks` adalah kontrak opsional untuk operasi tersebut.
2. `POST /api/v1/indexing/chunks` (backend SPI) menerima passage, membuat embedding passage melalui NVIDIA Embeddings dengan `input_type: passage`, lalu upsert vektor beserta metadata ke koleksi `document_chunk_vectors` di MongoDB Atlas.
3. `POST /api/v1/retrieval/search` (backend SPI) membuat embedding query dengan `input_type: query`, menjalankan Atlas `$vectorSearch`, lalu secara default mengirim kandidat teratas ke Nemotron Rerank 8B untuk pengurutan ulang.

Key NVIDIA berada di environment backend dan tidak pernah dikirim oleh frontend. Backend membuat embeddings untuk passage dan query sehingga kontrak mencegah embedding ganda.

`CHUNKING_API_BASE_URL` hanya diperlukan bila chunking eksternal dipilih. Route indexing dan retrieval adalah route NestJS SPI (`/api/v1/indexing/chunks` dan `/api/v1/retrieval/search`). Worker dokumen melakukan indexing melalui service internal setelah ekstraksi. Vector index Atlas harus dibuat mengikuti [`../atlas/spi-chunks-vector-index.json`](../atlas/spi-chunks-vector-index.json).

## Keamanan dan perilaku umum

- HTTPS wajib di staging/production. Endpoint backend SPI memakai JWT Bearer; bila chunking dipisah, adapter ke layanan tersebut memakai token service-to-service `CHUNKING_API_KEY`.
- Indexing idempotent berdasarkan pasangan unik `documentVersionId + chunkId`; mengulang indexing memperbarui vektor yang sama, bukan membuat duplikat. Layanan chunking dapat memakai `Idempotency-Key` untuk mencegah hasil chunking ganda.
- `X-Request-Id` opsional dari caller; layanan membuat ID jika tidak diberikan dan mengembalikannya di response header.
- Dokumen PDF/file binary tidak dikirim ke layanan ini. Backend SPI mengirim teks per halaman setelah ekstraksi/OCR.
- Text passage dan metadata sumber harus disimpan bersama referensi: document, document version, nomor halaman, bagian/pasal, dan chunk ID. Jangan mengembalikan rujukan yang tidak ada di metadata kandidat.
- Nilai `topK` retrieval maksimal 100. Bila reranking dipakai, maksimal 50 kandidat dikirim ke endpoint NVIDIA reranker.
- `chunkId` stabil untuk kombinasi `documentVersionId + page range + normalized content`; versi dokumen baru menghasilkan namespace chunk baru.
- Kegagalan NVIDIA atau vector store harus dikembalikan sebagai error terstruktur. Jangan mengembalikan stack trace, secret, atau teks dokumen pada error.

## 1. Membuat chunks

`POST /api/v1/chunking/chunks`

Request:

```json
{
  "documentId": "65f1d7a0a4a0a3c3f0100001",
  "documentVersionId": "65f1d7a0a4a0a3c3f0100002",
  "pages": [
    { "pageNumber": 1, "text": "Tujuan kebijakan ini adalah ...", "section": "1. Tujuan" },
    { "pageNumber": 2, "text": "Pelaksanaan audit dilakukan ...", "section": "2. Pelaksanaan" }
  ],
  "options": { "maxTokens": 700, "overlapTokens": 100, "preservePageBoundaries": true }
}
```

`maxTokens` default 700 dan rentang 100–3000; `overlapTokens` default 100 dan harus kurang dari `maxTokens`. Estimasi token dilakukan layanan chunking. Chunk tidak boleh melewati batas dokumen/versi. Bila chunk melewati halaman, `pageStart` dan `pageEnd` harus dicantumkan; `pageNumber` tunggal boleh dikosongkan.

Response `200`:

```json
{
  "documentId": "65f1d7a0a4a0a3c3f0100001",
  "documentVersionId": "65f1d7a0a4a0a3c3f0100002",
  "chunks": [
    {
      "chunkId": "sha256:7c8e...",
      "text": "Tujuan kebijakan ini adalah ...",
      "pageStart": 1,
      "pageEnd": 1,
      "section": "1. Tujuan",
      "ordinal": 0,
      "tokenCount": 12
    }
  ],
  "count": 1,
  "requestId": "req_01J..."
}
```

Caller meneruskan `chunks` tersebut ke indexing. Bila response terlalu besar untuk synchronous HTTP, kontrak dapat diperluas ke `202` plus `jobId`; versi awal harus membatasi jumlah teks request agar response synchronous tetap praktis.

## 2. Membuat embedding dan meng-index chunks

`POST /api/v1/indexing/chunks`

Request menerima metadata yang sama seperti response chunking:

```json
{
  "documentId": "65f1d7a0a4a0a3c3f0100001",
  "documentVersionId": "65f1d7a0a4a0a3c3f0100002",
  "chunks": [
    {
      "chunkId": "sha256:7c8e...",
      "text": "Tujuan kebijakan ini adalah ...",
      "pageStart": 1,
      "pageEnd": 1,
      "section": "1. Tujuan",
      "ordinal": 0
    }
  ]
}
```

Layanan membuat embedding per batch (mematuhi batas token/model), menyimpan vector dan payload metadata ke vector store, serta melakukan upsert berdasarkan `chunkId`. `embeddingModel` boleh dihilangkan untuk memakai konfigurasi server. Bila dimensi model berubah, jangan mencampur vektor dengan dimensi/model berbeda dalam collection yang sama; buat collection/version baru dan re-index.

Response `200`:

```json
{
  "status": "INDEXED",
  "documentId": "65f1d7a0a4a0a3c3f0100001",
  "documentVersionId": "65f1d7a0a4a0a3c3f0100002",
  "indexedCount": 1,
  "skippedCount": 0,
  "embeddingModel": "nvidia/nemotron-3.5-embed-1b",
  "requestId": "req_01J..."
}
```

Operasi re-index versi yang sama mengganti vektor dengan ID sama tanpa menduplikasi; versi dokumen lama tidak dihapus otomatis.

## 3. Mencari sources

`POST /api/v1/retrieval/search`

Request:

```json
{
  "query": "Apakah rapat evaluasi wajib mencatat tindak lanjut?",
  "filters": {
    "documentIds": ["65f1d7a0a4a0a3c3f0100001"],
    "documentVersionIds": ["65f1d7a0a4a0a3c3f0100002"]
  },
  "topK": 20,
  "rerank": true,
  "rerankTopN": 20
}
```

`query` wajib dan maksimal 8000 karakter. `topK` default 20, rentang 1–100. `rerank` default `true`; `rerankTopN` default 20 dan maksimal 50. Jika `rerank=false`, hasil diurutkan menurut skor vector search. Filter document/version hanya boleh merujuk versi ACTIVE yang pengguna berwenang akses; service pemanggil tetap wajib melakukan otorisasi resource.

Response `200`:

```json
{
  "query": "Apakah rapat evaluasi wajib mencatat tindak lanjut?",
  "sources": [
    {
      "chunkId": "sha256:7c8e...",
      "documentId": "65f1d7a0a4a0a3c3f0100001",
      "documentVersionId": "65f1d7a0a4a0a3c3f0100002",
      "pageStart": 1,
      "pageEnd": 1,
      "section": "4. Tindak Lanjut",
      "text": "Setiap rapat evaluasi mencatat ...",
      "retrievalScore": 0.82,
      "rerankScore": 3.71
    }
  ],
  "count": 1,
  "embeddingModel": "nvidia/nemotron-3.5-embed-1b",
  "rerankModel": "nvidia/nemotron-3.5-rerank-8b",
  "requestId": "req_01J..."
}
```

`rerankScore` hanya ada bila reranking aktif. `retrievalScore` dan `rerankScore` adalah skor model yang berbeda dan tidak boleh dibandingkan langsung. Retrieval harus mengembalikan teks sumber dan metadata aktual dari vector store supaya review LLM bisa memakai source yang dapat diverifikasi.

## Error format

Semua error mengikuti format:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Field query wajib diisi",
    "details": [{ "field": "query", "issue": "required" }]
  },
  "requestId": "req_01J..."
}
```

Status: `400` invalid input, `401` token invalid, `403` caller tidak berwenang, `404` document/version tidak ditemukan, `409` idempotency conflict, `413` request melebihi batas, `429` rate limit/provider quota, `502` NVIDIA/vector provider gagal, `503` service belum siap. Error tidak boleh berisi secret atau konten dokumen.

## Konfigurasi service yang diharapkan

```env
CHUNKING_API_BASE_URL=https://chunk-service.internal
CHUNKING_API_KEY=<token internal service>
NVIDIA_API_KEY=<key server-side yang sama untuk endpoint NVIDIA yang diizinkan>
MONGODB_VECTOR_COLLECTION=document_chunk_vectors
MONGODB_VECTOR_INDEX_NAME=spi_chunks_vector_idx
NVIDIA_EMBEDDING_DIMENSIONS=2048
CHAT_AI_EMBEDDING_ENDPOINT=https://integrate.api.nvidia.com/v1/embeddings
CHAT_AI_EMBEDDING_MODEL=nvidia/nemotron-3.5-embed-1b
NVIDIA_RERANK_ENDPOINT=https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-rerank-8b/reranking
NVIDIA_RERANK_MODEL=nvidia/nemotron-3.5-rerank-8b
```

`CHUNKING_API_KEY` adalah token layanan chunking eksternal, bukan NVIDIA API key. Backend SPI sendiri memakai JWT untuk route indexing/retrieval.
