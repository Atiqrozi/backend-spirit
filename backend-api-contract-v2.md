# Kontrak API Backend SPI v2

Semua route memakai prefix global `/api/v1` (diatur melalui `API_PREFIX`). Swagger tersedia di `/docs`. Request yang membutuhkan autentikasi memakai `Authorization: Bearer <accessToken>`. Respons error mengikuti format NestJS saat ini: `{ "statusCode": 400, "message": "...", "error": "Bad Request" }`; error layanan/provider harus disanitasi.

Status umum: `200` berhasil membaca/memperbarui, `201` resource dibuat (POST review enqueue saat ini `200`), `400` validasi, `401` token tidak valid, `403` role/resource ditolak, `404` resource tidak ditemukan, `409` konflik status/idempotency, `413` file melebihi batas, dan `502/503` provider/dependency gagal atau belum siap. ValidationPipe NestJS dapat mengembalikan `message` sebagai array.

## Role

| Role | Hak pada area evaluasi |
|---|---|
| `ADMIN_SPI` | Mengelola seluruh laporan sesuai kewenangan dan melakukan evaluasi, approval, verifikasi. |
| `PIMPINAN_SPI` | Membaca laporan, mengevaluasi manusia, menyetujui rekomendasi, memberi keputusan, memverifikasi tindak lanjut. |
| `ANGGOTA_SPI` | Membaca laporan miliknya, melihat evaluasi yang diizinkan, mengerjakan follow-up yang ditugaskan dan mengirim bukti. |

Resource laporan untuk `ANGGOTA_SPI` dibatasi pada laporan dengan `createdBy` sama dengan subject JWT. Follow-up anggota dibatasi ke `assigneeId` yang sama. Cakupan unit belum tersedia pada model pengguna sehingga belum dapat diterapkan.

## Reports dan versions

| Method | Endpoint | Akses |
|---|---|---|
| `GET` | `/reports` | JWT; anggota hanya laporan miliknya |
| `POST` | `/reports` | ADMIN_SPI, ANGGOTA_SPI |
| `GET` | `/reports/:reportId` | JWT + pemeriksaan resource |
| `GET` | `/reports/:reportId/versions` | JWT + pemeriksaan resource |
| `GET` | `/reports/:reportId/versions/:versionId` | JWT + pemeriksaan resource |
| `POST` | `/reports/:reportId/versions` | JWT + pemeriksaan resource; multipart `file` PDF |

Version adalah snapshot. Upload versi baru tidak menghapus file atau hasil versi sebelumnya.

## AI Review

Route lama `/reports/:reportId/reviews` dipertahankan. `/ai-review` adalah nama eksplisit untuk kebutuhan frontend dan memakai pipeline/collection yang sama.

| Method | Endpoint | Akses |
|---|---|---|
| `POST` | `/reports/:reportId/reviews` (existing) / `/reports/:reportId/ai-review` | PIMPINAN_SPI, ADMIN_SPI; memasukkan job ke BullMQ |
| `GET` | `/reports/:reportId/reviews` (existing) / `/reports/:reportId/ai-review` | JWT + pemeriksaan resource; riwayat |
| `GET` | `/reports/:reportId/ai-review/:reviewId` | JWT + pemeriksaan resource; snapshot beserta findings, sources, recommendations |
| `POST` | `/reports/:reportId/ai-review/:reviewId/retry` | PIMPINAN_SPI, ADMIN_SPI; hanya review FAILED, membuat snapshot/job baru |
| `GET` | `/reports/:reportId/ai-review/:reviewId/findings` | JWT + pemeriksaan resource |
| `GET` | `/reports/:reportId/ai-review/:reviewId/findings/:findingId` | JWT + pemeriksaan resource |
| `PATCH` | `/reports/:reportId/ai-review/:reviewId/findings/:findingId` | PIMPINAN_SPI, ADMIN_SPI |
| `GET` | `/reports/:reportId/ai-review/:reviewId/regulation-mapping` | JWT + pemeriksaan resource |
| `GET` | `/reports/:reportId/ai-review/:reviewId/regulation-mapping/:mappingId` | JWT + pemeriksaan resource |

POST review mengembalikan `202`-style acceptance body (implementasi HTTP saat ini `200`):

```json
{
  "queued": true,
  "jobId": "report-review-...",
  "reviewId": "...",
  "reportVersionId": "..."
}
```

Review menyimpan versi laporan yang dipilih ketika job dibuat, model AI, model embedding/rerank, waktu, sumber retrieval, status AI, status verifikasi manusia, limitations, hasil per dokumen acuan (`regulationAssessments`), temuan, dan rekomendasi. Status finding: `COMPLIANT`, `NON_COMPLIANT`, `PARTIALLY_COMPLIANT`, `NOT_ASSESSABLE`. Source hanya dapat merujuk chunk yang dikembalikan Atlas Vector Search. Kutipan dan halaman laporan disimpan hanya jika kutipan benar-benar ada pada teks halaman yang diekstrak. Tidak ada keputusan hukum/approval otomatis.

Untuk memenuhi Evidence & Regulation Mapping frontend, `GET /reports/:reportId/ai-review/:reviewId/regulation-mapping` dan detail review juga perlu menyertakan metadata snapshot dokumen acuan: `document: { id, title, number?, category? }` dan `documentVersion: { id, version }`. Snapshot metadata disimpan saat review dibuat agar perubahan nama dokumen di kemudian hari tidak mengubah riwayat evaluasi. Jika metadata tidak tersedia, kembalikan `null` dan tampilkan ID; jangan menebak nama/nomor regulasi. File tetap diakses lewat endpoint file bertanda tangan, bukan URL permanen dalam mapping.

## Recommendations

| Method | Endpoint | Akses |
|---|---|---|
| `GET` | `/reports/:reportId/ai-review/:reviewId/recommendations?page=&limit=` | JWT + pemeriksaan resource; response `{items,page,limit,total}` |
| `PATCH` | `/reports/:reportId/ai-review/:reviewId/recommendations/:recommendationId` | PIMPINAN_SPI, ADMIN_SPI |
| `POST` | `/reports/:reportId/ai-review/:reviewId/recommendations/:recommendationId/approve` | PIMPINAN_SPI, ADMIN_SPI |
| `POST` | `/reports/:reportId/ai-review/:reviewId/recommendations/:recommendationId/reject` | PIMPINAN_SPI, ADMIN_SPI |

Jenis rekomendasi: `REPORT_IMPROVEMENT` dan `INSPECTION_IMPROVEMENT`. Status: `PENDING_REVIEW`, `NEEDS_VERIFICATION`, `APPROVED`, `REJECTED`. Field patch yang didukung: `reviewNote`, `action`, `priority`, `verificationStatus`. Body keputusan: `{ "note": "..." }`. Rekomendasi `NEEDS_VERIFICATION` perlu diverifikasi manusia sebelum dapat disetujui untuk task.

Contoh rekomendasi:

```json
{
  "type": "INSPECTION_IMPROVEMENT",
  "title": "Perjelas bukti monitoring",
  "description": "Bukti pada laporan belum cukup untuk memastikan frekuensi monitoring.",
  "rationale": "Informasi yang tersedia tidak menyebutkan tanggal monitoring.",
  "action": "Verifikasi jadwal dan lampirkan bukti monitoring.",
  "priority": "MEDIUM",
  "verificationStatus": "NEEDS_VERIFICATION",
  "status": "NEEDS_VERIFICATION",
  "sourceChunkIds": [],
  "reportEvidence": []
}
```

## Human evaluations

| Method | Endpoint | Akses |
|---|---|---|
| `POST` | `/reports/:reportId/evaluations` | PIMPINAN_SPI, ADMIN_SPI; body opsional `{reviewId,note}` |
| `GET` | `/reports/:reportId/evaluations` | JWT + pemeriksaan resource |
| `GET` | `/reports/:reportId/evaluations/:evaluationId` | JWT + pemeriksaan resource; termasuk temuan/rekomendasi/riwayat |
| `PATCH` | `/reports/:reportId/evaluations/:evaluationId` | PIMPINAN_SPI, ADMIN_SPI; catatan dan keputusan per temuan |
| `POST` | `/reports/:reportId/evaluations/:evaluationId/approve` | PIMPINAN_SPI, ADMIN_SPI |
| `POST` | `/reports/:reportId/evaluations/:evaluationId/request-revision` | PIMPINAN_SPI, ADMIN_SPI |

Keputusan per temuan menerima status compliance yang sama dengan finding dan catatan. Approval manusia mengubah status laporan menjadi `APPROVED`; permintaan revisi menjadi `NEEDS_REVISION`. Endpoint lama `/reports/:id/approve` dan `/request-revision` tetap tersedia untuk kompatibilitas.

Contoh PATCH evaluasi:

```json
{
  "note": "Sumber dan bukti telah ditinjau.",
  "findingDecisions": [{
    "findingId": "66f000000000000000000020",
    "status": "PARTIALLY_COMPLIANT",
    "note": "Bukti untuk sebagian unit tersedia."
  }]
}
```

## Follow-up (menggunakan `tasks` existing)

| Method | Endpoint | Akses |
|---|---|---|
| `POST` | `/reports/:reportId/follow-ups` | PIMPINAN_SPI, ADMIN_SPI; membuat task dari recommendation APPROVED |
| `GET` | `/reports/:reportId/follow-ups?page=&limit=` | JWT + pemeriksaan resource; anggota hanya follow-up assigned |
| `GET` | `/reports/:reportId/follow-ups/:followUpId` | JWT + pemeriksaan resource/assignee |
| `PATCH` | `/reports/:reportId/follow-ups/:followUpId` | Assignee atau ADMIN_SPI; transisi ke `IN_PROGRESS` |
| `POST` | `/reports/:reportId/follow-ups/:followUpId/submit-evidence` | Assignee atau ADMIN_SPI; multipart `file` PDF/JPG/PNG dan `description` |
| `POST` | `/reports/:reportId/follow-ups/:followUpId/verify` | PIMPINAN_SPI, ADMIN_SPI; `{decision,note}` |
| `GET` | `/reports/:reportId/follow-ups/:followUpId/history` | JWT + pemeriksaan resource/assignee |
| `POST` | `/reports/:reportId/close` | PIMPINAN_SPI, ADMIN_SPI; menutup laporan setelah seluruh follow-up berstatus COMPLETED |

Body create: `{ "recommendationId": "ObjectId", "assigneeId": "ObjectId", "dueDate": "ISO-8601" }`. `assigneeId` dan `dueDate` opsional. Keputusan verify: `COMPLETED`, `REVISION_REQUIRED`, atau `REJECTED`; bukti yang pernah diunggah tidak ditimpa. Unique index recommendation mencegah follow-up kedua dari rekomendasi yang sama.

Contoh response create follow-up (task adalah relasi ke koleksi tasks yang sama):

```json
{
  "_id": "66f000000000000000000001",
  "reportId": "66f000000000000000000010",
  "reportVersionId": "66f000000000000000000011",
  "reviewId": "66f000000000000000000012",
  "evaluationId": "66f000000000000000000013",
  "recommendationId": "66f000000000000000000014",
  "taskId": "66f000000000000000000015",
  "status": "ASSIGNED",
  "assigneeId": "66f000000000000000000016",
  "dueDate": "2026-12-01T00:00:00.000Z"
}
```

Status follow-up: `OPEN`, `ASSIGNED`, `IN_PROGRESS`, `SUBMITTED`, `UNDER_VERIFICATION`, `REVISION_REQUIRED`, `COMPLETED`, `REJECTED`. `UNDER_VERIFICATION` dicatat di history saat keputusan diverifikasi.

## Retrieval, chunking, vector database

Worker memakai chunking lokal (`TextChunkerService`) lalu embedding NVIDIA dan indexing/search MongoDB Atlas melalui `VectorStoreService`. Route SPI yang tersedia: `POST /indexing/chunks` (ADMIN_SPI) dan `POST /retrieval/search` (JWT). Adapter HTTP `ChunkingClient` dan `RetrievalClient` belum digunakan karena spesifikasi layanan eksternal aktual tidak tersedia. Jangan membuat embedding atau vector store kedua.

## Notifications

Kontrak lengkap inbox pengguna, unread count, filter, mark-read, preferensi kanal, delivery logs, email uji, event workflow, schema, index, dan RBAC ditetapkan di [`contracts/NOTIFICATIONS-API-CONTRACT.md`](contracts/NOTIFICATIONS-API-CONTRACT.md). Dokumen tersebut melengkapi endpoint existing `GET /notifications/logs` dan `POST /notifications/test-email`; route inbox/preferences dan event-driven delivery belum diimplementasikan.

Kontrak target untuk gap frontend prioritas tinggi/menengah (dashboard, task, user/unit/settings, dokumen/OCR, file privat, template, filter laporan, dan timeline) ada di [`contracts/FRONTEND-API-COMPLETION-CONTRACT.md`](contracts/FRONTEND-API-COMPLETION-CONTRACT.md). Route ditandai ada/belum ada dan dokumentasi target tidak menyatakan route yang belum dibuat sebagai implementasi aktif.

## Pagination dan keterbatasan kontrak

Recommendations dan follow-ups memakai `{items,page,limit,total}`. Beberapa route existing masih mengembalikan array terbatas; migrasi response perlu koordinasi frontend. Scope per unit belum dimodelkan. File bukti tersimpan di ImageKit dan MongoDB hanya menyimpan metadata file. Implementasi saat ini menyimpan URL ImageKit; kebijakan private/signed URL perlu ditetapkan sebelum data sensitif digunakan di produksi.
