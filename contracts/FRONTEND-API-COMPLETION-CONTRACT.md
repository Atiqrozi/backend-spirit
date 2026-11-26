# Kontrak API Pelengkap Frontend SPI

Dokumen ini mencakup gap prioritas tinggi dan menengah dari `frontend/requirements.md` yang tidak tercakup penuh oleh route backend saat ini. Ini adalah **kontrak target**, bukan klaim bahwa seluruh route sudah tersedia. Prefix `/api/v1`; JSON UTF-8; autentikasi `Authorization: Bearer <accessToken>`. Semua waktu dikirim ISO-8601 UTC dan ditampilkan frontend dalam `Asia/Jakarta`.

Kontrak notifikasi lengkap ada di [`NOTIFICATIONS-API-CONTRACT.md`](NOTIFICATIONS-API-CONTRACT.md). Kontrak evaluasi tetap di [`../backend-api-contract-v2.md`](../backend-api-contract-v2.md).

## 1. Aturan umum

### Pagination

Semua endpoint list target menerima `page` (default `1`, min `1`), `limit` (default `20`, min `1`, max `100`), `sortBy` dari allowlist per resource, dan `sortOrder=asc|desc` (default desc), serta mengembalikan:

```json
{ "items": [], "page": 1, "limit": 20, "total": 0 }
```

Jangan mengembalikan seluruh data sebagai array tanpa `total` bila list mendukung pagination. Urutan default `createdAt DESC, _id DESC`; filter dan sorting hanya menerima enum/field yang diizinkan. Sort key yang tidak dikenal menghasilkan `400`, bukan diteruskan ke query MongoDB.

### Error

Gunakan format konsisten `{ "statusCode": 400, "message": "...", "error": "Bad Request", "code": "VALIDATION_ERROR" }`. Status penting: `400` validasi, `401` sesi, `403` role/resource, `404` resource tidak ditemukan/di luar scope, `409` konflik status/versi, `413` upload terlalu besar, `422` aturan bisnis, `429` rate limit, `5xx` dependency. Jangan bocorkan stack trace, token, secret, password hash, atau error mentah provider.

### Scope akses

- `ADMIN_SPI`: administrasi lintas unit.
- `PIMPINAN_SPI`: laporan dan penugasan dalam scope SPI yang diizinkan; dapat menetapkan assignee sesuai aturan.
- `ANGGOTA_SPI`: laporan yang dibuat/ditugaskan kepadanya dan task yang dibuat/ditugaskan kepadanya.
- Semua endpoint memeriksa scope di server. Frontend route guard bukan pengganti otorisasi API.
- Sampai `unitId` diimplementasikan dan diisi, jangan mengklaim pembatasan per unit; response wajib menyebut/mengikuti scope yang benar-benar dikonfigurasi.

## 2. Dashboard role-scoped — prioritas tinggi

### `GET /dashboard/summary` (route ada; kontrak dan scope harus ditambah)

Preserve field existing untuk kompatibilitas: `reports` dan `tasks` tetap array agregat `{_id,count}`, `referenceDocuments` tetap angka. Tambahkan ringkasan terstruktur, daftar aktivitas, dan tenggat. Query opsional: `activityLimit` (default 5, max 20), `deadlineLimit` (default 5, max 20).

```json
{
  "scope": { "role": "ANGGOTA_SPI", "unitId": null },
  "reports": [{ "_id": "NEEDS_REVISION", "count": 2 }],
  "tasks": [{ "_id": "ASSIGNED", "count": 4 }],
  "referenceDocuments": 12,
  "metrics": {
    "reportTotal": 4,
    "taskTotal": 5,
    "tasksDueSoon": 2,
    "tasksOverdue": 1,
    "followUpsOpen": 2,
    "referenceDocumentsActive": 12,
    "referenceDocumentsProcessing": 1
  },
  "recentActivity": [{
    "id": "66f000000000000000000101",
    "type": "REPORT_REVISION_REQUESTED",
    "title": "Revisi laporan diminta",
    "resource": { "type": "REPORT", "id": "66f000000000000000000102", "route": "/app/reports/66f000000000000000000102" },
    "occurredAt": "2026-11-22T01:00:00.000Z"
  }],
  "upcomingDeadlines": [{
    "taskId": "66f000000000000000000201",
    "title": "Pemeriksaan ruang",
    "dueAt": "2026-11-23T01:00:00.000Z",
    "status": "ASSIGNED",
    "resourceRoute": "/app/tasks/66f000000000000000000201"
  }]
}
```

Semua metrics/list wajib dihitung dari data yang boleh dilihat caller. `recentActivity` hanya memakai event yang tercatat, tidak mengarang timeline. Jika aktivitas belum memiliki sumber audit yang cukup, kembalikan array kosong dan jangan membuat placeholder.

Definisi metrik harus stabil: `tasksDueSoon` = task aktif dengan tenggat dalam 7x24 jam ke depan; `tasksOverdue` = task aktif dengan `dueDate < now`; task `COMPLETED`/`CANCELLED` tidak dihitung. `followUpsOpen` mengecualikan `COMPLETED` dan `REJECTED`. Gunakan satu waktu acuan UTC untuk satu response.

## 3. Penugasan SPI dan unit — prioritas tinggi

### Daftar, detail, buat, dan ubah task

| Method | Endpoint | Status |
|---|---|---|
| `GET` | `/tasks?page=&limit=&status=&priority=&assigneeId=&unitId=&search=&dueFrom=&dueTo=` | Ada; filter/pagination/scope belum lengkap |
| `GET` | `/tasks/:taskId` | Belum ada |
| `POST` | `/tasks` | Ada; payload hanya sebagian field target |
| `PATCH` | `/tasks/:taskId` | Ada; dukungan field dan transisi status perlu dilengkapi |
| `GET` | `/tasks/:taskId/history` | Belum ada |

Target body `POST /tasks` (semua enum dan ID divalidasi):

```json
{
  "title": "Pemeriksaan dokumen unit",
  "description": "Verifikasi daftar dokumen yang berlaku.",
  "unitId": "66f000000000000000000010",
  "assigneeId": "66f000000000000000000016",
  "priority": "HIGH",
  "startDate": "2026-11-22T01:00:00.000Z",
  "dueDate": "2026-11-29T01:00:00.000Z",
  "instructions": "Periksa versi aktif dan catat hasilnya.",
  "referenceDocumentIds": ["66f000000000000000000020"],
  "reminders": { "enabled": true, "offsetMinutes": [1440, 60] },
  "recurrenceId": null
}
```

`priority`: `LOW|MEDIUM|HIGH|CRITICAL`; task status: `OPEN|ASSIGNED|IN_PROGRESS|COMPLETED|CANCELLED`. Validasi `startDate <= dueDate`, assignee aktif, unit yang ada, referensi dokumen yang dapat diakses, dan izin pembuat. Respons create adalah task dengan `_id`, `createdBy`, `status`, `data`, `createdAt`, `updatedAt`.

Filter list mendukung exact status/priority/assignee/unit, search pada title, dan rentang tenggat. User non-admin hanya mendapat task yang dibuat/ditugaskan kepadanya sesuai kebijakan. Jangan menerima `assigneeId` yang tidak diizinkan.

`GET /tasks/:taskId` mengembalikan metadata task beserta `unit`, `assignee`, `referenceDocuments[]` (metadata saja), `checklist[]`, attachment metadata, recurrence summary, dan `progress:{completedItems,totalItems,percent}`. Nilai progress dihitung dari checklist item yang benar-benar tersimpan; tanpa checklist, `totalItems=0` dan `percent=null`, bukan progress tebakan.

### Checklist, attachment, dan history task

| Method | Endpoint | Fungsi/akses |
|---|---|---|
| `POST` | `/tasks/:taskId/checklist-items` | Admin/Pimpinan atau pembuat task; body `{title, order?}` |
| `PATCH` | `/tasks/:taskId/checklist-items/:itemId` | Assignee; body `{completed, note?}` |
| `POST` | `/tasks/:taskId/attachments` | Assignee/pembuat berizin; multipart `file` dan `description?` |
| `DELETE` | `/tasks/:taskId/attachments/:attachmentId` | Pengunggah atau Admin; soft delete dan audit |
| `GET` | `/tasks/:taskId/history?page=&limit=` | Hanya pengguna dengan akses task |

Checklist item: `{_id,title,completed,completedBy,completedAt,order,note}`. Attachment response hanya metadata dan `fileId`; akses download lewat signed URL (Bagian 6). History berisi `actorId`, `action`, `fromStatus`, `toStatus`, `note`, `occurredAt`; tidak memuat isi file.

### Recurrence dan occurrence

Pertahankan `POST /tasks/:id/recurrence`, `GET /tasks/:id/occurrences`, dan `PATCH /occurrences/:id/status`, tetapi ganti body `any` dengan DTO tervalidasi. Recurrence body:

```json
{
  "frequency": "WEEKLY",
  "interval": 1,
  "daysOfWeek": [1, 3, 5],
  "timezone": "Asia/Jakarta",
  "startDate": "2026-11-23T02:00:00.000Z",
  "endDate": null
}
```

Validasi frequency `DAILY|WEEKLY|MONTHLY`, interval positif terbatas, hari 0–6, timezone IANA valid, dan tanggal akhir tidak mendahului awal. Occurrence menyimpan `taskId`, `dueAt`, `status`, dan reminder-state. H-1 dan 60 menit sebelum due time menggunakan BullMQ/Redis, timezone recurrence, retry terbatas, dan idempotency key. Perubahan status occurrence memeriksa assignee/scope dan transisi yang sah.

### Direktori assignee dan unit

| Method | Endpoint | Akses/status |
|---|---|---|
| `GET` | `/users/assignees?unitId=&role=&search=&page=&limit=` | Belum ada; hanya user aktif yang boleh dipilih caller |
| `GET` | `/organization/units?page=&limit=&search=` | Belum ada; daftar unit sesuai scope |
| `GET` | `/organization/units/:unitId` | Belum ada |
| `POST` | `/organization/units` | ADMIN_SPI |
| `PATCH` | `/organization/units/:unitId` | ADMIN_SPI; jangan hard-delete unit yang telah direferensikan |

Item assignee memuat `{id,name,email,role,unitId,unitName,active}`; jangan kembalikan hash, token, atau credential. Unit memuat `{_id,name,code,active,createdAt,updatedAt}`. Model user saat ini belum memiliki `unitId`; perlu migrasi schema/data sebelum filter unit dapat dianggap aktif.

## 4. Pengguna dan pengaturan — prioritas tinggi/menengah

### Pengguna

| Method | Endpoint | Status/akses |
|---|---|---|
| `GET` | `/users` | Ada, Admin saja; kontrak target memakai pagination envelope dan filter `role`, `active`, `unitId`, `search` |
| `POST` | `/users` | Ada, Admin saja; tambah konflik email `409` dan respons konsisten |
| `PATCH` | `/users/:userId` | Ada, Admin saja; allowlist field `name`, `role`, `active`, `unitId`; password diubah lewat flow khusus |
| `GET` | `/users/me` | Belum ada; semua role |
| `PATCH` | `/users/me` | Belum ada; semua role; hanya field profil aman |
| `POST` | `/users/me/change-password` | Belum ada; semua role, password lama dan baru divalidasi |

`GET /users/me` response `{id,name,email,role,unitId,unitName,active}`. `PATCH /users/me` menerima `{name}`; perubahan email membutuhkan verifikasi email terpisah sebelum diaktifkan. Ganti password menerima `{currentPassword,newPassword}`; jangan mengembalikan password/hash. Admin tidak boleh menonaktifkan diri sendiri atau menghapus satu-satunya admin aktif.

### Profil organisasi dan system settings

| Method | Endpoint | Akses/status |
|---|---|---|
| `GET` | `/organization/profile` | JWT; belum ada |
| `PATCH` | `/organization/profile` | ADMIN_SPI; belum ada |
| `GET` | `/system/settings` | ADMIN_SPI; belum ada |
| `PATCH` | `/system/settings` | ADMIN_SPI; belum ada, hanya allowlist non-secret |

Profil organisasi memuat nama resmi, logo URL publik yang disetujui, timezone, alamat/kontak umum bila digunakan. System settings memuat aturan non-secret seperti timezone default dan reminder defaults. Secret tidak pernah dikembalikan melalui GET atau disertakan pada response PATCH.

### Status integrasi

| Method | Endpoint | Akses/status |
|---|---|---|
| `GET` | `/admin/integrations` | ADMIN_SPI; belum ada; status aman tanpa secret |
| `PUT` | `/admin/integrations/:provider/credentials` | ADMIN_SPI; belum ada; secret hanya masuk server melalui HTTPS |

GET mengembalikan `{provider,configured,lastCheckedAt,status}` saja. PUT menerima credential provider yang divalidasi, menyimpan ke secret manager/environment server sesuai deployment, menulis audit event, dan mengembalikan `{provider,configured:true,masked:true}`. Secret lama tidak pernah dapat dibaca kembali. Jika secret manager belum tersedia, endpoint write harus tetap nonaktif dan Swagger menyatakan `503`, bukan menyimpan credential plaintext ke MongoDB.

## 5. Dokumen referensi dan OCR — prioritas menengah

| Method | Endpoint | Status |
|---|---|---|
| `GET` | `/documents?page=&limit=&search=&category=&status=&sortBy=&sortOrder=` | Ada; query hanya sebagian, response array dan scope access perlu dilengkapi |
| `POST` | `/documents` | Ada; Admin SPI |
| `GET` | `/documents/:documentId` | Ada tetapi sekarang alias status; targetnya metadata dokumen |
| `PATCH` | `/documents/:documentId` | Belum ada; metadata allowlist |
| `POST` | `/documents/:documentId/archive` | Belum ada; Admin SPI, soft archive |
| `GET` | `/documents/:documentId/versions` | Belum ada; riwayat versi |
| `GET` | `/documents/:documentId/versions/:versionId` | Belum ada |
| `GET` | `/documents/:documentId/versions/:versionId/process-status` | Belum ada; status/job extraction per versi |
| `GET` | `/documents/:documentId/versions/:versionId/pages?page=&limit=` | Belum ada; teks/status OCR per halaman |
| `POST` | `/documents/:documentId/versions` | Ada; multipart PDF/JPG/PNG, 20 MB default, Admin SPI |
| `POST` | `/documents/:documentId/publish` | Ada; Admin SPI |
| `POST` | `/documents/:documentId/reprocess` | Ada; Admin SPI |

List memakai envelope pagination. Dokumen memuat `{_id,title,number,category,description,status,version,createdBy,createdAt,updatedAt}`. Versi memuat `{_id,documentId,version,status,file:{fileId,fileName,mimeType,sizeBytes},processing:{jobId,progress?,errorCode?},createdAt}`; jangan mengirim URL storage permanen secara default.

Process status response: `{documentId,versionId,status,job:{id,state,progress?,attemptsMade?,errorCode?},processing:{startedAt?,completedAt?}}`; job state `WAITING|ACTIVE|COMPLETED|FAILED`. Jangan mengembalikan stack trace worker. Pages response: `{items:[{pageNumber,status,text?,errorCode?}],page,limit,total}`. Teks halaman hanya tersedia untuk caller dengan hak baca dokumen; endpoint boleh membatasi panjang field `text` dan memiliki route detail halaman jika teks besar. OCR tidak menjamin verifikasi tanda tangan/stempel.

Kategori dokumen target: `SPO|REGULATION|TEMPLATE|OTHER`. Nilai historis lain tetap dibaca sebagai label raw sampai dimigrasikan; API menolak kategori baru yang tidak dikenal. Archive adalah soft archive dan tidak menghapus file/chunk yang sudah direferensikan oleh snapshot evaluasi lama.

## 6. Akses file aman — prioritas menengah

Tidak ada `files.controller` saat ini; ImageKit service internal hanya upload/delete. Tambahkan:

`GET /files/:fileId/access?disposition=inline|attachment`

JWT wajib. Service menemukan pemilik file dan memeriksa akses ke report/document/task/evidence induknya sebelum membuat URL ImageKit bertanda tangan dengan masa berlaku pendek (target 5 menit). Response `200`:

```json
{
  "url": "https://...signed-url...",
  "expiresAt": "2026-11-22T01:05:00.000Z",
  "fileName": "dokumen.pdf",
  "mimeType": "application/pdf"
}
```

URL mentah provider tidak disimpan sebagai link publik untuk objek private. Setiap akses baru diverifikasi lagi; unauthorized resource memberi `404`. Validasi MIME/size tetap dilakukan saat upload.

## 7. Template laporan — prioritas menengah

| Method | Endpoint | Status |
|---|---|---|
| `GET` | `/templates?page=&limit=&search=&status=&sortBy=&sortOrder=` | Ada; saat ini array max 100 |
| `GET` | `/templates/:templateId` | Belum ada |
| `POST` | `/templates` | Ada; Admin SPI |
| `PATCH` | `/templates/:templateId` | Belum ada; hanya metadata draft |
| `GET` | `/templates/:templateId/versions` | Belum ada |
| `GET` | `/templates/:templateId/versions/:versionId` | Belum ada |
| `GET` | `/templates/:templateId/versions/:versionId/preview` | Belum ada; response data preview yang aman untuk browser |
| `POST` | `/templates/:templateId/versions` | Ada; Admin SPI |
| `POST` | `/templates/:templateId/publish` | Ada; Admin SPI |
| `POST` | `/templates/:templateId/archive` | Belum ada; Admin SPI |

Template version harus immutable setelah dipakai laporan. Kontrak field template yang ditargetkan:

```json
{
  "name": "Laporan Inspeksi",
  "description": "Format laporan inspeksi SPI.",
  "fields": [{
    "key": "inspectionDate",
    "label": "Tanggal inspeksi",
    "type": "DATE",
    "required": true,
    "order": 1,
    "section": "Identitas",
    "options": []
  }]
}
```

`type`: `TEXT|LONG_TEXT|DATE|NUMBER|SELECT|MULTI_SELECT|BOOLEAN`; `key` unik dalam satu versi; `options` hanya wajib untuk SELECT types. POST version membuat snapshot baru. Preview endpoint mengembalikan `templateVersionId`, `name`, `sections`, dan daftar field berurutan tanpa mengeksekusi HTML/template arbitrary. Detail version tetap menjadi sumber snapshot. Perubahan field yang dipakai versi laporan lama tidak boleh mengubah snapshot lama.

## 8. Daftar laporan dan timeline — prioritas menengah

### List/query

`GET /reports?page=&limit=&status=&type=&unitId=&search=&createdFrom=&createdTo=&sortBy=&sortOrder=`

Route ada, tetapi saat ini hanya menerima `page`, membatasi 100, dan mengembalikan array. Target response pagination envelope; filter dan scope harus diterapkan sebelum pagination. Role anggota hanya melihat report yang diizinkan, bukan hasil agregat global.

### Metadata, tim, dan attachment laporan

Route `POST /reports` saat ini hanya menerima `title`, `type`, `unit`, dan `templateVersionId`. Target DTO menambahkan `unitId`, `period:{startDate,endDate,label}`, `teamMemberIds[]`, dan `responsibleUserId?`; `createdBy` tetap actor pembuat. `type` menggunakan `INSPEKSI|MONITORING|EVALUASI|RAPAT|LAINNYA`. `unit` string dipertahankan sementara sebagai field kompatibilitas dan dideprekasi setelah data memiliki `unitId`. `responsibleUserId` hanya dapat dipilih Admin/Pimpinan dan harus user aktif dalam scope.

Representasi report menempatkan field tersebut di `data`: `{title,type,unitId,unit,period,teamMemberIds,responsibleUserId,templateVersionId}`. `PATCH /reports/:reportId` hanya mengubah metadata allowlist; tidak dapat mengubah `createdBy`, status workflow, versi file, atau hasil AI. Perubahan metadata berpengaruh pada laporan aktif, bukan snapshot historis evaluasi.

`GET /reports/:reportId` response harus memuat metadata itu beserta versi terbaru dan status proses ringkas; data sensitif file tidak memuat URL permanen. Nama anggota tim dan responsible person ditampilkan sebagai safe user projection `{id,name,role}`.

| Method | Endpoint | Akses/status |
|---|---|---|
| `PATCH` | `/reports/:reportId` | Belum ada; update metadata allowlist sebelum/selama workflow sesuai izin |
| `GET` | `/reports/:reportId/attachments` | Belum ada; akses sama dengan report |
| `POST` | `/reports/:reportId/attachments` | Belum ada; multipart file PDF/JPG/PNG, metadata tercatat |
| `DELETE` | `/reports/:reportId/attachments/:attachmentId` | Belum ada; Admin/pengunggah sesuai status, soft-delete dan audit |
| `GET` | `/reports/:reportId/versions/:versionId/process-status` | Belum ada; status ekstraksi versi laporan |
| `GET` | `/reports/:reportId/versions/:versionId/pages?page=&limit=` | Belum ada; halaman teks/status ekstraksi versi laporan |

Version report utama (PDF) tetap immutable. Attachment response berisi metadata `fileId`, bukan URL storage permanen; akses lewat `/files/:fileId/access`. Status proses dan halaman mengikuti response contract dokumen/OCR di atas dan pemeriksaan akses report.

### Timeline gabungan

`GET /reports/:reportId/history?page=&limit=&cursor=` (belum ada)

Gabungkan event yang sudah tersimpan dari versi laporan, ekstraksi, AI review, evaluasi manusia, keputusan rekomendasi, perubahan status, dan follow-up. Response item:

```json
{
  "items": [{
    "id": "66f000000000000000000301",
    "type": "HUMAN_EVALUATION_APPROVED",
    "actor": { "id": "66f000000000000000000016", "name": "Evaluator SPI" },
    "fromStatus": "UNDER_REVIEW",
    "toStatus": "APPROVED",
    "note": "Bukti telah ditinjau.",
    "resource": { "type": "EVALUATION", "id": "66f000000000000000000302" },
    "occurredAt": "2026-11-22T01:00:00.000Z"
  }],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

Urutan kronologis terbaru dahulu. Timeline tidak boleh menyintesis event dari field status terkini bila riwayat aslinya tidak dicatat. Akses sama dengan detail report. History follow-up existing tetap dapat diakses melalui route detail follow-up.

## 9. Kebutuhan kontrak/implementasi lain yang masih terbuka

- `GET /ready` saat ini hanya memeriksa MongoDB. Untuk deployment worker, response readiness perlu memasukkan Redis/BullMQ dan dependency wajib, atau dokumentasikan health check terpisah.
- Swagger harus memuat DTO, enum, query, multipart, response, dan error untuk route existing maupun kontrak baru. Beberapa controller sekarang menggunakan `any` dan array tanpa envelope.
- Route existing `GET /documents/:id`, dashboard summary, documents list, reports list, tasks list, templates list, users list, notification logs, dan audit logs perlu diuji dari sisi scope/RBAC dan pagination sebelum dianggap memenuhi kontrak target.
- API forgot/reset password tidak diwajibkan oleh frontend selama backend tidak mendukungnya; jangan tampilkan link aksi sebelum alur yang aman tersedia.
- Grafik tren tidak diwajibkan sampai endpoint agregat dan definisi metrik disepakati. Jangan menghitung skor kepatuhan di frontend.

## 10. Kriteria penerimaan lintas kontrak

1. Setiap route memiliki DTO tervalidasi, response TypeScript/OpenAPI, status/error, permission, dan contoh request/response.
2. Semua list menggunakan filter allowlist, scope access sebelum pagination, stable sort, `page/limit/total`.
3. Tidak ada akses lintas pengguna/unit melalui perubahan ID di URL atau query.
4. User, task, document, report, template, file, dan history memeriksa relasi resource sebelum membacakan/mengubahnya.
5. Upload tervalidasi server-side; file private hanya diakses melalui authorization dan URL bertanda tangan singkat.
6. Mutasi penting mencatat actor, waktu, perubahan status, dan referensi audit tanpa menyimpan secret/isi dokumen sensitif ke log.
7. Endpoint notifikasi mengikuti kontrak khusus notifikasi; job reminder dan delivery idempotent terhadap retry.
8. Kontrak baru ditambahkan ke Swagger dan dites untuk role Admin, Pimpinan, Anggota, ownership, invalid input, empty state, dan pagination.
