# SPI Compliance Backend

NestJS REST API untuk Sistem Pemantauan Kepatuhan Dokumen SPI. Seluruh source dan konfigurasi proyek berada di direktori `backend`.

## Menjalankan

1. Gunakan Node.js 24 atau lebih baru (renderer PDFium untuk OCR scan memerlukan Node 24).
2. Jalankan `npm install` dari direktori ini.
3. Salin `.env.example` menjadi `.env`, lalu isi MongoDB Atlas, Redis, JWT, ImageKit, NVIDIA, dan SMTP sesuai environment.
4. Jalankan `docker compose up -d redis` untuk Redis lokal, pastikan MongoDB Atlas tersedia, kemudian `npm run start:dev`.
5. Swagger tersedia di `/docs`; API berada di `/api/v1`.

## Membuat akun awal per role

Seeder mengelola akun untuk role (`ADMIN_SPI`, `ANGGOTA_SPI`, `PIMPINAN_SPI`) dengan nama dan email awal yang didefinisikan di `src/seeders/seed-users.ts`. Jika ingin memakai email rumah sakit, ubah nilai email di daftar tersebut sebelum menjalankan. Jalankan `npm run seed:users` dari folder `backend` setelah `MONGODB_URI` di `.env` mengarah ke database yang benar. Seeder meminta satu password (minimal 8 karakter), menyamarkannya, lalu menggunakan hash bcrypt yang sama untuk semua akun seed. Akun seed yang sudah ada dengan email yang sama diperbarui password-nya; role yang sudah terdaftar dengan email berbeda dilewati tanpa perubahan. Pastikan koneksi `.env` menunjuk ke database yang memang ingin diisi sebelum menjalankan perintah.

Jangan commit `.env`. Buat secret JWT acak yang panjang. NVIDIA API key hanya diisi pada environment lokal/secret manager. Variabel `CHAT_AI_API_KEY` mendukung konfigurasi klien yang diberikan; key kosong sengaja disediakan pada template.

## Modul yang tersedia

- Health/readiness, Swagger, MongoDB/Mongoose, BullMQ/Redis, scheduler, validasi DTO, Helmet, JWT, refresh token berotasi, dan role.
- User management, dokumen acuan dan upload versi melalui ImageKit, template, laporan/revisi/review job/approval manusia, tugas dan recurrence, log notifikasi email, dashboard, serta audit-log read API.
- Adapter NVIDIA OCR/chat/embedding; chunking lokal adalah jalur default, dengan adapter eksternal opsional bila diperlukan.
- Adapter NVIDIA Nemotron reranking (`NVIDIA_RERANK_ENDPOINT`), memakai `NVIDIA_API_KEY` yang sama dan menerima query plus daftar kandidat passage.
- Atlas Vector Search: indexing passage dan pencarian `$vectorSearch` tersedia melalui `POST /api/v1/indexing/chunks` dan `POST /api/v1/retrieval/search`.
- Worker BullMQ untuk ekstraksi teks PDF per halaman, OCR halaman scan via NVIDIA, chunking lokal, indexing dokumen acuan ke Atlas, dan review AI laporan dengan retrieval/reranking sumber.
- Evaluasi laporan v2: snapshot AI per versi laporan, temuan dan sumber terpetakan, rekomendasi perbaikan laporan/inspeksi, evaluasi manusia, serta follow-up yang memakai koleksi task existing, bukti ImageKit, verifikasi, dan history.
- Notifikasi saat ini menyediakan log email dan pengiriman email uji. Kontrak target inbox pengguna, badge belum dibaca, preferences, dan workflow delivery ada di [`contracts/NOTIFICATIONS-API-CONTRACT.md`](contracts/NOTIFICATIONS-API-CONTRACT.md); endpoint tambahan itu belum diimplementasikan.
- Gap API frontend prioritas tinggi/menengah dan kontrak target dashboard, task, user/unit/settings, dokumen/OCR, file aman, template, laporan/history dirangkum di [`contracts/FRONTEND-API-COMPLETION-CONTRACT.md`](contracts/FRONTEND-API-COMPLETION-CONTRACT.md); route yang ditandai belum ada masih perlu diimplementasikan.

## Integrasi yang perlu konfigurasi sebelum operasional

Kontrak RAG ada di [`contracts/RAG-API-CONTRACT.md`](contracts/RAG-API-CONTRACT.md) dan [`contracts/spi-rag-openapi.yaml`](contracts/spi-rag-openapi.yaml). Kontrak API final evaluasi ada di [`backend-api-contract-v2.md`](backend-api-contract-v2.md), gap frontend di [`contracts/FRONTEND-API-COMPLETION-CONTRACT.md`](contracts/FRONTEND-API-COMPLETION-CONTRACT.md), notifikasi di [`contracts/NOTIFICATIONS-API-CONTRACT.md`](contracts/NOTIFICATIONS-API-CONTRACT.md), audit di [`backend-api-audit.md`](backend-api-audit.md), skema database di [`database-schema-spi-v2.md`](database-schema-spi-v2.md), dan alur AI/human review di [`ai-evaluation-workflow.md`](ai-evaluation-workflow.md). Worker memakai chunking lokal dan MongoDB Atlas Vector Search; adapter HTTP chunking/retrieval eksternal belum digunakan karena dokumentasi layanan eksternal aktual belum tersedia. Index Atlas ada di [`atlas/README.md`](atlas/README.md); pilihan vector store ada di [`contracts/VECTOR-DB-OPTIONS.md`](contracts/VECTOR-DB-OPTIONS.md).

Deployment masih perlu generation occurrence reminder, policy akses privat/signed URL ImageKit, serta aturan dan format template organisasi sebelum alur tersebut digunakan di produksi. AI review tidak memberikan keputusan persetujuan final.

## Keamanan

File sensitif dan dokumen dikirim ke layanan pihak ketiga sesuai environment yang dikonfigurasi. Batasi akses ImageKit dan MongoDB Atlas, gunakan HTTPS, review kewenangan endpoint terhadap alur organisasi, dan simpan hanya metadata file di MongoDB. Jika sebuah API key pernah dibagikan melalui chat/IDE, cabut dan buat key baru sebelum dipakai lagi.
