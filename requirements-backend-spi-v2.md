# Requirements Backend SPI v2
## Sistem Pemantauan Kepatuhan Dokumen SPI

Dokumen ini menjadi acuan kebutuhan backend. Stack utama: NestJS + TypeScript, MongoDB Atlas sebagai database utama, ImageKit.io sebagai penyimpanan file PDF/dokumen, serta Redis + BullMQ untuk background jobs dan jangan lupa kamu gunakan swagger api untuk dokumentasi dari API.

## 1. Tujuan Sistem

Backend mendukung:
- Autentikasi, manajemen pengguna, role, dan hak akses.
- Pengelolaan dokumen acuan (SPO, Permenkes), versi, dan masa berlaku.
- Pengelolaan template laporan rapat/FGD dan versioning.
- Upload laporan, ekstraksi teks/OCR, pemeriksaan template, dan review AI.
- Temuan review dengan referensi sumber yang dapat ditelusuri.
- Revisi, review manusia, dan persetujuan laporan.
- Penugasan tugas, recurrence mingguan, pengingat otomatis.
- Dashboard, audit trail, dan log notifikasi.

AI hanya memberikan rekomendasi. Keputusan akhir kepatuhan dan persetujuan tetap dilakukan manusia yang berwenang.

## 2. Teknologi Utama

| Komponen | Teknologi | Tanggung jawab |
|---|---|---|
| Backend | NestJS + TypeScript | REST API dan business logic |
| Database utama | MongoDB Atlas | Data aplikasi dan metadata |
| ODM | Mongoose (`@nestjs/mongoose`) | Schema dan query MongoDB |
| File storage | ImageKit.io | Penyimpanan PDF/dokumen |
| Queue/cache | Redis + BullMQ | Background jobs dan antrean |
| Scheduler | `@nestjs/schedule` | Pemeriksaan jadwal |
| Authentication | JWT + refresh token | Autentikasi |
| API docs | Swagger/OpenAPI | Dokumentasi API |
| Validation | class-validator + class-transformer | Validasi DTO |
| Email | Nodemailer + SMTP | Pengingat email |
| AI/OCR | NVIDIA API | OCR, embedding bila dibutuhkan, dan review LLM |

**Keputusan database:** MongoDB Atlas menggantikan PostgreSQL/Prisma sebagai database utama pada versi ini. Gunakan Mongoose agar tidak ada dua database utama yang tumpang tindih.

## 3. Arsitektur Tingkat Tinggi

1. Frontend mengakses REST API NestJS.
2. NestJS memvalidasi DTO, JWT, dan RBAC.
3. Data aplikasi dan metadata disimpan di MongoDB Atlas.
4. File PDF/dokumen disimpan di ImageKit.io; MongoDB menyimpan `fileId`, `filePath`, URL, MIME type, ukuran, dan metadata terkait.
5. OCR, ekstraksi, indexing, review AI, ekspor, dan email dijalankan secara asynchronous melalui BullMQ.
6. Chunking dan retrieval memakai API internal yang sudah dimiliki. Kontrak API harus diperiksa sebelum integrasi.

MongoDB menyimpan data terstruktur dan metadata, bukan biner PDF/Base64. ImageKit menjadi tempat penyimpanan file.

## 4. Autentikasi dan RBAC

Role minimum:
- `ADMIN_SPI`: mengelola pengguna, role, dokumen acuan, template, konfigurasi, dan data sesuai kewenangan.
- `ANGGOTA_SPI`: mengunggah laporan, mengelola tugas yang menjadi tanggung jawabnya, melihat hasil review, dan mengajukan revisi.
- `PIMPINAN_SPI`: melihat dashboard/laporan dan melakukan persetujuan sesuai kewenangan.

Gunakan JWT access token dan refresh token. Simpan hash refresh token, terapkan rotasi dan pencabutan token. RBAC harus diterapkan di endpoint dan service, bukan hanya frontend.

## 5. Pengelolaan Dokumen Acuan

Dokumen acuan meliputi SPO, Permenkes, dan kebijakan terkait.

Fitur:
- Upload PDF/dokumen dan metadata: judul, nomor, kategori, deskripsi, tanggal terbit, tanggal berlaku, status, uploader, dan waktu unggah.
- Versioning; perubahan menghasilkan versi baru, bukan menimpa versi lama.
- Status seperti `DRAFT`, `ACTIVE`, dan `ARCHIVED`.
- Pencarian/filter berdasarkan judul, nomor, kategori, status, dan tanggal.
- Referensi file ImageKit dan status ekstraksi/indexing.
- Reprocess bila OCR atau indexing gagal.

## 6. Template Laporan

- Membuat, mengubah, mengaktifkan, dan mengarsipkan template laporan rapat/FGD.
- Menentukan field wajib/opsional dan aturan validasi.
- Setiap perubahan struktur menghasilkan versi template baru.
- Setiap review menyimpan referensi/snapshot versi template yang digunakan agar hasil lama tetap dapat ditelusuri.

## 7. Laporan dan Revisi

Setiap laporan memiliki metadata: judul, jenis, tanggal kegiatan, unit, pengunggah, status, dan relasi tugas opsional.

Setiap revisi disimpan sebagai versi baru. Jangan menimpa file, teks ekstraksi, atau hasil review versi sebelumnya.

Status yang disarankan: `UPLOADED`, `PROCESSING`, `UNDER_REVIEW`, `NEEDS_REVISION`, `RESUBMITTED`, `APPROVED`, dan `FAILED`.

Simpan riwayat revisi, reviewer, catatan, waktu tindakan, versi template, dan versi dokumen acuan yang digunakan.

## 8. Ekstraksi PDF dan OCR

Alur:
1. Validasi ukuran, ekstensi, MIME type, dan hak akses.
2. Upload PDF ke ImageKit.
3. Simpan metadata file dan status ke MongoDB.
4. Deteksi apakah PDF memiliki text layer.
5. Prioritaskan native PDF text extraction bila teks tersedia.
6. Jika PDF hasil scan, render setiap halaman menjadi PNG/JPG dan kirim ke OCR.
7. Simpan hasil ekstraksi per halaman beserta nomor halaman, status, dan error.
8. Tandai hasil OCR yang tidak terbaca untuk pemeriksaan manual.
9. Teruskan hasil ekstraksi ke pipeline chunking/indexing.
10. Perbarui status proses.

NVIDIA OCR endpoint:
`https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2`

OCR tidak dapat memastikan keaslian tanda tangan basah, stempel, atau validitas legal dokumen. Pemeriksaan tersebut tetap manual.

## 9. Integrasi Chunking dan Retrieval yang Sudah Ada

API chunking dan retrieval yang sudah dimiliki harus diintegrasikan, bukan dibangun ulang atau diasumsikan kontraknya.

Sebelum implementasi:
1. Periksa dokumentasi API aktual.
2. Verifikasi endpoint, autentikasi, request/response, timeout, error, dan retry.
3. Pastikan apakah chunking API sudah menghasilkan embedding.
4. Pastikan apakah retrieval API sudah melakukan embedding query dan mengelola vector database.
5. Hindari embedding ganda.

Gunakan embedding NVIDIA hanya jika layanan internal belum melakukannya.

Konfigurasi embedding opsional:
- Endpoint: `https://integrate.api.nvidia.com/v1/embeddings`
- Model: `nvidia/nemotron-3.5-embed-1b`

Pertahankan metadata yang dapat ditelusuri: `documentId`, `documentVersionId`, `pageNumber`, `section`/nomor pasal jika tersedia, dan `chunkId`. Jika vector database dikelola retrieval service, MongoDB cukup menyimpan metadata dan referensi chunk.

## 10. Review Laporan dengan AI

Gunakan:
- Teks laporan hasil ekstraksi/OCR.
- Versi template yang digunakan.
- Konteks SPO/Permenkes hasil retrieval.
- Aturan pemeriksaan yang telah ditentukan.

NVIDIA Chat Completions:
- Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions`
- Model: `nvidia/nemotron-3-ultra-550b-a55b`

Alur:
1. Pastikan laporan dan versi dokumen siap.
2. Panggil retrieval API untuk mendapatkan konteks relevan.
3. Kirim teks laporan, aturan template, dan konteks ke LLM.
4. Terima output terstruktur: ringkasan, ketidaksesuaian, prioritas, saran, dan sumber.
5. Validasi output dan simpan ke MongoDB.
6. Reviewer manusia memutuskan menerima, meminta revisi, atau meneruskan persetujuan.

Aturan:
- Temuan yang mengutip SPO/Permenkes wajib merujuk sumber/chunk yang benar-benar dikembalikan retrieval.
- Jangan mengarang nomor pasal, ayat, halaman, atau kutipan.
- Jika sumber tidak ditemukan, nyatakan bahwa rujukan belum tersedia/tidak dapat diverifikasi.
- AI tidak memberikan persetujuan legal final otomatis.
- Simpan metadata model/proses yang dibutuhkan untuk audit, tanpa menyimpan secret.

## 11. ImageKit.io untuk Penyimpanan PDF dan Dokumen

ImageKit.io digunakan untuk menyimpan file PDF laporan, dokumen SPO/Permenkes, dan lampiran yang diizinkan.

### 11.1 Tanggung jawab

- Menyimpan file biner PDF/dokumen.
- Menyediakan `fileId`, `filePath`, dan URL file.
- Mendukung upload, pengelolaan, dan penghapusan sesuai kebijakan retensi.
- MongoDB hanya menyimpan metadata dan referensi file.

Struktur folder yang disarankan:

```text
/spi/
  /reference-documents/{documentId}/{versionId}/
  /reports/{reportId}/{versionId}/
  /report-attachments/{reportId}/
  /exports/{year}/{month}/
```

### 11.2 Metadata file

Simpan metadata berikut pada dokumen terkait atau koleksi `files`:
- `provider`: `imagekit`
- `fileId`
- `fileName`
- `filePath`
- `url`
- `mimeType`
- `sizeBytes`
- `folder`
- `uploadedBy`
- `uploadedAt`
- `entityType` dan `entityId`
- `versionId`
- `checksum` bila dihitung
- `status`: `UPLOADED`, `ACTIVE`, `DELETED`, atau `UPLOAD_FAILED`

Gunakan `fileId` sebagai identitas operasi file; jangan hanya mengandalkan URL.

### 11.3 Alur upload

1. Frontend mengirim file ke endpoint backend yang terautentikasi.
2. Backend memvalidasi ukuran, ekstensi, MIME type, dan izin pengguna.
3. Backend membuat record/status upload di MongoDB.
4. Backend mengunggah file ke ImageKit menggunakan kredensial server-side.
5. Jika berhasil, simpan `fileId`, `filePath`, URL, ukuran, MIME type, dan metadata ke MongoDB.
6. Masukkan job ekstraksi/OCR ke BullMQ.
7. Jika gagal, tandai `UPLOAD_FAILED` dan sediakan mekanisme retry.

Untuk file besar, pertimbangkan direct upload ke ImageKit menggunakan autentikasi bertanda tangan yang dibuat backend, jika sesuai dengan SDK/konfigurasi ImageKit. Private key tidak boleh dikirim ke frontend.

### 11.4 Keamanan file

- Sesuaikan kebijakan akses ImageKit dengan sensitivitas dokumen.
- Jangan menganggap URL yang sulit ditebak sebagai kontrol akses.
- Untuk dokumen privat, gunakan mekanisme akses privat/signed URL sesuai fitur dan konfigurasi ImageKit yang dipilih.
- Backend memeriksa izin sebelum memberikan akses atau URL.
- Hindari URL privat jangka panjang di log.
- Terapkan retensi, pengarsipan, dan penghapusan yang dapat diaudit.
- Jangan mengirim dokumen sensitif ke pihak ketiga tanpa persetujuan dan dasar pemrosesan yang sesuai.

### 11.5 Konsistensi MongoDB dan ImageKit

MongoDB dan ImageKit bukan satu transaksi. Implementasikan kompensasi/reconciliation:
- Jika upload ImageKit berhasil tetapi penyimpanan metadata MongoDB gagal, lakukan pencatatan dan cleanup/reconciliation.
- Jika metadata dibuat tetapi upload gagal, tandai `UPLOAD_FAILED`.
- Buat job rekonsiliasi untuk mendeteksi metadata tanpa file atau file tanpa metadata bila API ImageKit mendukungnya.
- Jangan menghapus file versi lama saat upload revisi baru.

## 12. MongoDB Atlas sebagai Database Utama

### 12.1 Konfigurasi

- Gunakan cluster Atlas terpisah atau database terpisah untuk development, staging, dan production.
- Batasi Network Access/IP Access List.
- Buat database user dengan privilege minimum.
- Gunakan TLS dan connection string melalui `MONGODB_URI`.
- Aktifkan backup sesuai kebutuhan.
- Buat index pada field filter, pencarian, relasi, dan sorting.
- Gunakan pagination.
- Terapkan schema melalui Mongoose dan validasi DTO pada API.
- Atur connection pool dan timeout.
- Jangan mengekspos URI/kredensial di frontend, repository, atau log.

### 12.2 Koleksi yang disarankan

| Collection | Isi |
|---|---|
| `users` | Profil, email, password hash, status akun |
| `roles` | Role dan permission |
| `refresh_tokens` | Hash token, expiry, status pencabutan |
| `reference_documents` | Identitas dokumen SPO/Permenkes |
| `document_versions` | Versi dokumen dan metadata ImageKit |
| `document_pages` | Teks ekstraksi/OCR per halaman |
| `document_processing_jobs` | Status OCR, chunking, indexing |
| `document_chunk_refs` | Referensi chunk eksternal bila diperlukan |
| `report_templates` | Identitas template |
| `report_template_versions` | Versi dan aturan template |
| `reports` | Metadata laporan |
| `report_versions` | Versi file laporan dan metadata ImageKit |
| `report_reviews` | Riwayat review AI/manusia |
| `review_findings` | Temuan review terstruktur |
| `review_sources` | Referensi chunk/sumber |
| `approvals` | Keputusan dan catatan persetujuan |
| `tasks` | Tugas dan penanggung jawab |
| `task_recurrences` | Aturan pengulangan |
| `task_occurrences` | Instans tugas untuk tanggal tertentu |
| `reminder_rules` | Aturan waktu pengingat |
| `notification_logs` | Riwayat notifikasi |
| `notifications` | Inbox in-app per penerima dan status baca |
| `notification_preferences` | Preferensi kanal/kategori per pengguna |
| `audit_logs` | Aktivitas pengguna dan sistem |
| `files` | Metadata file ImageKit bila dipisah |

Tidak semua data wajib menjadi koleksi terpisah. Gunakan embedded subdocument untuk data kecil yang selalu dibaca bersama. Hindari array tanpa batas, misalnya seluruh audit trail di satu dokumen.

### 12.3 Relasi dan konsistensi

- Gunakan ObjectId untuk identitas dokumen.
- Gunakan reference antar-koleksi untuk entitas yang punya lifecycle/ukuran besar sendiri.
- Gunakan embedded document untuk data kecil yang selalu dibaca bersama.
- Tambahkan unique index untuk email dan idempotency key.
- Gunakan transaksi MongoDB jika cluster Atlas dan konfigurasi mendukungnya serta operasi membutuhkan atomicity lintas dokumen.
- Tentukan soft delete dan kebijakan retensi.

## 13. Penugasan dan Pengingat Mingguan

Task minimal:
- `title`, `description`, `assigneeId`, `createdBy`, `priority`, `dueDate`, `status`, dan relasi laporan opsional.

Recurrence:
- `daysOfWeek`
- `interval`
- `timezone`
- `startDate`
- `endDate` opsional

Timezone default: `Asia/Jakarta`.

Buat dokumen `task_occurrences` untuk jadwal yang dihasilkan. Scheduler memeriksa occurrence yang jatuh tempo dan memasukkan notifikasi ke BullMQ. Contoh pengingat: H-1 dan satu jam sebelum tenggat.

Simpan jadwal dan status di MongoDB agar tetap ada setelah restart server. BullMQ/Redis menangani antrean job.

Gunakan idempotency key unik dari kombinasi occurrence, penerima, channel, dan tipe pengingat untuk mencegah pengiriman ganda. Log status `PENDING`, `SENT`, atau `FAILED`.

## 14. Notifikasi

Tahap awal: email via Nodemailer + SMTP. Buat interface provider agar channel lain dapat ditambahkan, misalnya WhatsApp Business Platform resmi. Jangan menggunakan otomasi WhatsApp Web tidak resmi.

Log notifikasi mencakup penerima, channel, tipe pengingat, occurrence, status, waktu percobaan, waktu berhasil, error yang disanitasi, dan idempotency key.

Kontrak target inbox, unread count, filter, mark-read, preference, log delivery, event dan RBAC ada di [`contracts/NOTIFICATIONS-API-CONTRACT.md`](contracts/NOTIFICATIONS-API-CONTRACT.md). Route inbox dan preference merupakan kebutuhan yang belum diimplementasikan; endpoint existing `/notifications/logs` dan `/notifications/test-email` tetap dipertahankan.

## 15. Background Jobs

Queue BullMQ:
- `document-extraction`
- `document-ocr`
- `document-chunking`
- `document-indexing`
- `report-review`
- `report-export`
- `task-reminder`
- `email-delivery`
- `imagekit-reconciliation`

Terapkan retry terbatas, exponential backoff, timeout, concurrency limit, dan penanganan kegagalan. Job harus aman diulang tanpa membuat versi atau notifikasi duplikat.

## 16. Rancangan REST API

Gunakan prefix `/api/v1`.

| Modul | Contoh endpoint |
|---|---|
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout` |
| Users | `GET /users`, `POST /users`, `PATCH /users/:id` |
| Documents | `GET /documents`, `POST /documents`, `GET /documents/:id`, `POST /documents/:id/versions` |
| Processing | `GET /documents/:id/process-status`, `POST /documents/:id/reprocess` |
| Templates | `GET /templates`, `POST /templates`, `POST /templates/:id/versions`, `POST /templates/:id/publish` |
| Reports | `GET /reports`, `POST /reports`, `GET /reports/:id`, `POST /reports/:id/versions` |
| Reviews | `POST /reports/:id/reviews`, `GET /reports/:id/reviews` |
| Approvals | `POST /reports/:id/approve`, `POST /reports/:id/request-revision` |
| Tasks | `GET /tasks`, `POST /tasks`, `PATCH /tasks/:id`, `POST /tasks/:id/recurrence` |
| Occurrences | `GET /tasks/:id/occurrences`, `PATCH /occurrences/:id/status` |
| Notifications | `GET /notifications`, `GET /notifications/unread-count`, `GET /notifications/:id`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`, `GET/PATCH /notifications/preferences`, `GET /notifications/logs`, `POST /notifications/test-email` |
| Dashboard | `GET /dashboard/summary` |
| Audit | `GET /audit-logs` |
| Health | `GET /health`, `GET /ready` |

Finalisasi endpoint berdasarkan kebutuhan frontend dan kebijakan akses. Semua endpoint memerlukan DTO, validasi, Swagger, dan RBAC.

Gap endpoint prioritas tinggi/menengah dari `frontend/requirements.md`, termasuk target request/response/RBAC untuk dashboard, task, unit/user/settings, dokumen/OCR, akses file, template, dan report history, didokumentasikan di [`contracts/FRONTEND-API-COMPLETION-CONTRACT.md`](contracts/FRONTEND-API-COMPLETION-CONTRACT.md). Dokumen itu membedakan route yang sudah ada dari route target yang belum diimplementasikan. Kontrak notifikasi lengkap berada di [`contracts/NOTIFICATIONS-API-CONTRACT.md`](contracts/NOTIFICATIONS-API-CONTRACT.md).

## 17. Struktur Modul NestJS

```text
src/
  common/
    decorators/
    guards/
    filters/
    interceptors/
    pipes/
    utils/
  config/
  database/
  auth/
  users/
  roles/
  files/
    imagekit/
  documents/
  document-processing/
  templates/
  reports/
  reviews/
  approvals/
  tasks/
  reminders/
  notifications/
  audit-logs/
  dashboard/
  health/
  queues/
    processors/
    producers/
  integrations/
    nvidia/
    chunking/
    retrieval/
```

Pisahkan adapter integrasi eksternal dari business logic.

## 18. Environment Variables

Contoh `.env.example` (isi secret hanya di environment/secret manager, jangan commit):

```env
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1
APP_TIMEZONE=Asia/Jakarta

# MongoDB Atlas
MONGODB_URI=

# Redis / BullMQ
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_TLS=false

# JWT
JWT_ACCESS_SECRET=
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_SECRET=
JWT_REFRESH_EXPIRES_IN=7d

# ImageKit
IMAGEKIT_PUBLIC_KEY=
IMAGEKIT_PRIVATE_KEY=
IMAGEKIT_URL_ENDPOINT=

# NVIDIA
NVIDIA_API_KEY=
NVIDIA_OCR_ENDPOINT=https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2
NVIDIA_CHAT_ENDPOINT=https://integrate.api.nvidia.com/v1/chat/completions
NVIDIA_CHAT_MODEL=nvidia/nemotron-3-ultra-550b-a55b
NVIDIA_EMBEDDING_ENDPOINT=https://integrate.api.nvidia.com/v1/embeddings
NVIDIA_EMBEDDING_MODEL=nvidia/nemotron-3.5-embed-1b

# Existing internal APIs: fill from their actual documentation
CHUNKING_API_BASE_URL=
CHUNKING_API_KEY=
RETRIEVAL_API_BASE_URL=
RETRIEVAL_API_KEY=

# SMTP
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=

# Reminder
REMINDER_OFFSETS=24h,1h
```

Gunakan satu `NVIDIA_API_KEY` melalui NestJS ConfigService untuk layanan NVIDIA terkait. Jangan menulis secret di source code, frontend, dokumentasi publik, atau Git.

## 19. Keamanan

- HTTPS untuk komunikasi.
- Password hash dengan Argon2id atau bcrypt berkonfigurasi aman.
- Secret, MongoDB URI, ImageKit private key, SMTP password, dan NVIDIA API key disimpan di secret manager/environment.
- Terapkan RBAC dan pemeriksaan akses resource.
- Rate limiting untuk autentikasi dan upload.
- Validasi file berdasarkan MIME type, ekstensi, ukuran, dan pemeriksaan keamanan yang sesuai.
- Batasi akses Atlas dengan Network Access dan database user minimum privilege.
- Sanitasi error layanan eksternal dan jangan log secret.
- Audit aktivitas upload, perubahan versi, review, approval, perubahan role, dan penghapusan.
- Minimalkan data sensitif yang dikirim ke layanan AI eksternal.
- Terapkan retensi dan penghapusan sesuai kebijakan organisasi.

## 20. Performa dan Keandalan

- Jalankan OCR, indexing, review AI, ekspor, dan email secara asynchronous.
- Gunakan pagination dan index MongoDB.
- Hindari memuat file besar seluruhnya ke memory jika streaming tersedia.
- Batasi ukuran upload dan concurrency pemrosesan.
- Terapkan timeout, retry, backoff, dan circuit breaker bila diperlukan.
- Pantau latency dan kegagalan integrasi.
- Siapkan backup/restore MongoDB Atlas.
- Siapkan rekonsiliasi metadata MongoDB dengan file ImageKit.

## 21. Pengujian

Minimal:
- Unit test service, validator, guard, dan business rules.
- Integration test MongoDB, Redis, dan adapter ImageKit (mock/test environment).
- Test auth, refresh token, RBAC, dan akses lintas pengguna.
- Test upload, validasi file, kegagalan ImageKit, dan rekonsiliasi.
- Test native PDF extraction dan OCR per halaman.
- Test chunking/retrieval sesuai dokumentasi API aktual.
- Test AI review dengan mock dan validasi referensi sumber.
- Test versioning dokumen, template, dan laporan.
- Test recurrence, timezone, idempotency, retry, dan email.
- Security test upload, akses file, dan endpoint sensitif.

## 22. Tahapan Implementasi

1. Foundation: NestJS, config, MongoDB Atlas/Mongoose, Redis/BullMQ, Swagger, logging, health check.
2. Auth & RBAC: users, roles, JWT, refresh token, guards.
3. File storage: ImageKit, validasi upload, metadata, kebijakan akses.
4. Dokumen & template: pengelolaan dan versioning.
5. PDF processing: native extraction, OCR, status per halaman, antrean.
6. Chunking/retrieval: integrasi API internal setelah kontraknya diverifikasi; cegah embedding ganda.
7. Laporan & AI review: versioning, review, temuan, sumber, revisi, approval manusia.
8. Dashboard & export.
9. Tasks & reminders: recurrence, scheduler, BullMQ, SMTP, notification logs.
10. Hardening & deployment: keamanan, backup, monitoring, UAT, dokumentasi.

## 23. Hal yang Harus Dikonfirmasi Sebelum Implementasi

- Dokumentasi dan contoh request/response API chunking dan retrieval.
- Apakah chunking sudah membuat embedding.
- Apakah retrieval sudah membuat embedding query dan mengelola vector database.
- Batas ukuran dan format file yang diizinkan.
- Kebijakan akses ImageKit: privat, signed URL, atau delivery policy lain yang disetujui.
- Kebijakan retensi dokumen dan file.
- Alur persetujuan dan kewenangan tiap role.
- Format template laporan dan aturan pemeriksaan.
- SMTP yang akan digunakan.
- Environment deployment dan kebijakan backup Atlas.

## Prinsip Implementasi

1. MongoDB Atlas adalah database utama aplikasi.
2. ImageKit.io menyimpan file PDF/dokumen; MongoDB menyimpan metadata dan referensinya.
3. Versi dokumen dan laporan harus dapat ditelusuri.
4. Proses berat berjalan melalui background jobs.
5. API chunking/retrieval yang sudah ada digunakan sesuai kontrak aktual.
6. AI memberi rekomendasi berbasis sumber yang dapat diverifikasi; persetujuan akhir tetap oleh manusia.
7. Tidak ada secret di source code, frontend, dokumentasi publik, atau Git.
