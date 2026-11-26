# Audit API Backend SPI: Laporan dan Evaluasi

Tanggal audit: 22 November 2026  
Ruang lingkup: kontrak dan implementasi yang saat ini tersedia di `backend/src`, `backend/contracts`, `backend/atlas`, serta `requirements-backend-spi-v2.md`. Audit ini tidak mengubah endpoint existing.

## Ringkasan

Backend sudah memiliki fondasi NestJS, MongoDB/Mongoose, JWT, role guard, Swagger, ImageKit, BullMQ, ekstraksi/OCR, chunking lokal, indexing Atlas Vector Search, retrieval/reranking NVIDIA, review AI asynchronous, keputusan approval dasar, task, dan audit log. Integrasi retrieval yang benar-benar dipakai worker adalah `VectorStoreService` di Atlas. Adapter `ChunkingClient` dan `RetrievalClient` untuk API terpisah belum digunakan. Tidak ada dokumentasi API chunking/retrieval eksternal yang terlampir selain kontrak internal proyek; implementasi tidak boleh menganggap adapter eksternal itu sebagai layanan yang sudah tersedia.

Fitur inti yang belum ada adalah evaluasi manusia dengan riwayat terpisah, evidence mapping laporan ↔ sumber regulasi, dua kategori rekomendasi AI yang dapat diverifikasi/diterima, pembuatan follow-up dari rekomendasi, submit/verifikasi bukti follow-up, status workflow yang jelas, serta audit trail mutasi untuk alur tersebut. Task yang ada belum memenuhi fungsi follow-up dan beberapa route task tidak membatasi hak akses terhadap pemilik/assignee.

## Endpoint existing

Prefix global berasal dari `API_PREFIX`, default `/api/v1`. Daftar aktual:

| Modul | Endpoint | Catatan |
|---|---|---|
| Health | `GET /health`, `GET /ready` | Readiness hanya memeriksa MongoDB, belum Redis/worker. |
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` | Refresh token dirotasi dan hash disimpan pada user; hanya satu sesi refresh per user. |
| Users | `GET /users`, `POST /users`, `PATCH /users/:id` | Semua dibatasi ADMIN_SPI. |
| Documents | `GET/POST /documents`, `GET /documents/:id`, `GET /documents/:id/process-status`, `POST /documents/:id/versions`, `POST /documents/:id/publish`, `POST /documents/:id/reprocess` | `GET /:id` dan status belum memeriksa resource access secara spesifik. |
| Templates | `GET/POST /templates`, `POST /templates/:id/versions`, `POST /templates/:id/publish` | Versioning dasar; DTO dan respons Swagger terbatas. |
| Reports | `GET/POST /reports`, `GET /reports/:id`, `POST /reports/:id/versions`, `POST /reports/:id/reviews`, `GET /reports/:id/reviews`, `POST /reports/:id/approve`, `POST /reports/:id/request-revision` | Review asynchronous; approval langsung mengubah status laporan. |
| Tasks | `GET/POST /tasks`, `PATCH /tasks/:id`, `POST /tasks/:id/recurrence`, `GET /tasks/:id/occurrences`, `PATCH /occurrences/:id/status` | Task generik, tanpa bukti tindak lanjut, transisi tervalidasi, atau history. |
| Vector | `POST /indexing/chunks`, `POST /retrieval/search` | Backend SPI sendiri; indexing hanya ADMIN_SPI, retrieval setiap JWT valid. |
| Dashboard | `GET /dashboard/summary` | Tidak ada filter kewenangan/unit. |
| Audit | `GET /audit-logs` | ADMIN_SPI dapat membaca; writer/audit interceptor belum terlihat. |
| Notifications | `GET /notifications/logs`, `POST /notifications/test-email` | Email uji langsung; belum terkait workflow follow-up. |

Swagger menggunakan prefix `docs` (URL `/docs`) dan bearer auth global di metadata, namun endpoint belum mendokumentasikan DTO/response/error secara konsisten.

## Pemetaan kebutuhan dan kekurangan

| Area | Sudah tersedia | Kekurangan utama |
|---|---|---|
| Detail dan versi laporan | GET laporan, upload versi PDF, pemrosesan ekstraksi | Belum ada `GET /reports/:id/versions` dan detail versi. Akses laporan perlu diperiksa konsisten per endpoint. |
| AI review | Queue `report-review`, retrieval Atlas, rerank NVIDIA, snapshot `Review`, findings dan source references | Endpoint memakai `/reviews`, bukan `/ai-review`; jangan ganti agar kompatibel. Belum ada get-by-review-id, retry eksplisit, status/job detail, kategori evaluasi/keterbatasan/confidence, peraturan per evaluasi, dan hasil per referensi. Worker memilih versi terbaru saat mulai, bukan mematok versi ketika job dibuat. |
| Source traceability | Temuan menyimpan `sourceChunkIds`; `ReviewSource` menyimpan chunk, document/version, page range, section, text yang dikembalikan vector store | Tidak ada validasi ulang bahwa dokumen/versi sumber ada dan masih sah; tidak ada nama/nomor dokumen regulasi snapshot, kutipan terpisah, mapping ke halaman laporan, atau status assessment per regulasi. Tidak boleh menyimpulkan page/section yang tidak dikembalikan sumber. |
| Rekomendasi | `suggestion` pada finding | Tidak ada entitas/rekomendasi terpisah, jenis `REPORT` vs `INSPECTION`, status approval/rejection, alasan rekomendasi, bukti terkait, maupun konversi rekomendasi ke task. Prompt AI hanya meminta `summary/findings`; format output yang dibutuhkan prompt audit belum diterapkan. |
| Evaluasi manusia | Approval records dasar melalui approve/request-revision | Belum ada evaluasi manusia beridentitas/riwayat, catatan per temuan, override status compliance, review sumber, atau endpoint baca/ubah/evaluasi. Keputusan approval tidak memvalidasi review/versi dan hasil approval disimpan terpisah tetapi tanpa snapshot versi. |
| Follow-up | Task dengan title, description, assignee, due date, recurrence | Belum terhubung ke laporan/review/finding/rekomendasi; tidak ada status tindak lanjut yang diminta, submit evidence, verifikasi/revisi, maupun history. Route update/status tidak memiliki RBAC/resource ownership memadai. |
| MongoDB | Koleksi laporan, versi, review, finding, sources, approval, task dan vector; unique vector key `documentVersionId + chunkId` | Mayoritas domain memakai `Schema.Types.Mixed` dan `strict:false`; tipe/relasi/index spesifik untuk review/finding/source/approval/task/history tidak didefinisikan. Pagination beberapa endpoint membatasi limit tetapi tidak memvalidasi page dan tidak mengembalikan total. |
| Workflow | Status extraction dan laporan dasar; antrean BullMQ dengan retry | Status `UNDER_REVIEW` dipakai untuk AI berjalan dan menunggu keputusan manusia; tidak ada status eksplisit AI selesai/human review/follow-up/closed. Re-review membuat review baru, tetapi UI tidak punya detail/status per review. |
| Keamanan/RBAC | JWT guard, decorator role, beberapa pembatasan pembuat laporan | Role checks tidak lengkap pada laporan, pencarian vector, dokumen, task. Anggota dibatasi list laporan berdasarkan creator tetapi report access helper hanya memeriksa creator; unit/assignee scope tidak ada. Update task/occurrence dapat dilakukan user lain. Validasi DTO sebagian belum efektif untuk `any` body; response/file access belum punya signed/private URL policy. |
| Audit/idempotensi | Queue jobs diberi jobId; vector index upsert idempotent | Tidak ada audit trail mutasi evaluasi/task/finding dan idempotency key untuk membuat follow-up. Retry review dapat menulis ulang children untuk job yang sama; snapshot final harus immutable setelah selesai dan retry terkontrol. |
| Ekstraksi/chunking/retrieval | OCR/NVIDIA, native PDF extraction, chunking lokal word-based, Atlas vector store dan reranking | `ChunkingClient`/`RetrievalClient` tidak dipakai. Kontrak aktual integrasi yang dipakai adalah kontrak internal Atlas (`contracts/RAG-API-CONTRACT.md`), bukan API eksternal. Chunking lokal menyimpan batas halaman dan chunk ID. Vector dimension default 2048 harus cocok dengan model/index yang terpasang Atlas. |

## Risiko duplikasi dan kompatibilitas

1. Jangan membuat queue/module task kedua: perluas `tasks` existing dengan `followUp` linkage dan endpoint yang ber-prefix laporan.
2. Jangan membuat embedding/vector database kedua: `VectorStoreService` dan Atlas sudah menjadi pemilik indexing/retrieval, dengan NVIDIA embedding dan reranking.
3. Pertahankan `/reports/:id/reviews` serta `/reports/:id/approve` dan `/request-revision`; tambahkan alias/endpoint kebutuhan baru atau perluas respons secara kompatibel.
4. `ReviewFinding` dan `ReviewSource` sudah dapat menjadi dasar temuan/sumber. Tambahkan struktur khusus secara bertahap tanpa menghapus koleksi/data lama.
5. Belum ada dokumentasi aktual dari layanan chunking/retrieval eksternal. Jangan mengaktifkan `ChunkingClient` atau `RetrievalClient` sampai pemilik API memberikan kontrak dan kredensial yang tervalidasi.
6. `report.data` dan `reportVersion.data` dapat mengandung metadata template; perilaku existing dipertahankan. Perlu audit frontend untuk memastikan nama field/status yang telah dikonsumsi sebelum perubahan response.

## Rencana perubahan bertahap

1. **Kontrak dan dokumentasi:** pertahankan route existing; rancang DTO/response stabil untuk review snapshot, finding, source mapping, recommendation, human evaluation, dan follow-up. Tambahkan OpenAPI detail serta file kontrak final.
2. **Model non-destruktif:** tambahkan schema/collection typed dengan timestamps, referensi ObjectId, index akses/pencarian, status enum, snapshot versi, dan history; data lama tetap dapat dibaca.
3. **AI review:** pin `reportVersionId` ketika antrean dibuat; validasi setiap source chunk dari hasil Atlas; simpan snapshot model/waktu/sumber; pisahkan rekomendasi laporan dan pelaksanaan inspeksi; simpan assessment status dan keterbatasan tanpa keputusan legal otomatis.
4. **Human review:** tambah endpoint baca/ubah temuan, mapping, rekomendasi, evaluasi manusia, approval/revision; terapkan pemeriksaan role dan akses resource di controller serta service.
5. **Follow-up melalui task existing:** buat task dari rekomendasi yang disetujui secara idempotent; tambah linkage, status transition, upload evidence via ImageKit, verifikasi/revisi, dan history/audit.
6. **Dokumentasi dan verifikasi:** lengkapi tiga dokumen yang diminta (`backend-api-contract-v2.md`, `database-schema-spi-v2.md`, `ai-evaluation-workflow.md`), Swagger, diagram, lalu unit/integration/RBAC tests dengan mock provider. Jalankan build dan test relevan; integrasi eksternal tidak memerlukan kredensial nyata.

## Keputusan yang diperlukan sebelum implementasi integrasi eksternal

Tidak diperlukan untuk membuat kontrak backend baru. Untuk integrasi layanan chunking/retrieval milik pihak lain, dokumentasi aktual endpoint, autentikasi, payload, dan contoh respons belum tersedia di workspace; tahap itu harus tetap menggunakan jalur lokal + Atlas sampai spesifikasi tersebut tersedia.
