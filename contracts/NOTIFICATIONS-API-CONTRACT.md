# Kontrak API Notifikasi SPI

Status dokumen: kontrak target untuk melengkapi frontend. Implementasi saat ini baru memiliki `GET /notifications/logs` dan `POST /notifications/test-email`; inbox pengguna, status baca, preferensi, dan pengiriman berbasis event belum tersedia.

Semua route menggunakan prefix `/api/v1`, JSON UTF-8, dan autentikasi `Authorization: Bearer <accessToken>`. Timestamp dikirim UTC dalam ISO-8601; frontend menampilkan waktu menggunakan `Asia/Jakarta`. Role: `ADMIN_SPI`, `PIMPINAN_SPI`, `ANGGOTA_SPI`.

## 1. Model dan kategori

Pisahkan tiga konsep berikut:

- `notifications`: inbox in-app per pengguna, termasuk status baca.
- `notification_preferences`: preferensi kanal dan kategori milik seorang pengguna.
- `notification_logs`: catatan delivery/percobaan email dan kanal lain. Koleksi existing ini bukan inbox.

Model notifikasi:

```json
{
  "_id": "66f000000000000000000101",
  "recipientUserId": "66f000000000000000000016",
  "eventId": "task-assigned:66f000000000000000000201:66f000000000000000000016",
  "category": "FOLLOW_UP_ASSIGNED",
  "priority": "IMPORTANT",
  "title": "Tindak lanjut ditugaskan kepada Anda",
  "message": "Lengkapi bukti tindak lanjut sebelum tenggat.",
  "resource": {
    "type": "FOLLOW_UP",
    "id": "66f000000000000000000201",
    "route": "/app/reports/66f000000000000000000010?tab=followups"
  },
  "readAt": null,
  "createdAt": "2026-11-22T01:00:00.000Z"
}
```

`resource.route` harus dibentuk server dari allowlist route internal, bukan URL arbitrer dari body/event. Endpoint tujuan tetap melakukan otorisasi object-level saat deep link dibuka.

Kategori kontrak: `TASK_ASSIGNED`, `TASK_DUE_SOON`, `TASK_OVERDUE`, `REPORT_SUBMITTED`, `REPORT_REVISION_REQUESTED`, `REPORT_EVALUATION_COMPLETED`, `FOLLOW_UP_ASSIGNED`, `FOLLOW_UP_EVIDENCE_SUBMITTED`, `FOLLOW_UP_REVISION_REQUIRED`, `FOLLOW_UP_VERIFIED`. Prioritas: `NORMAL`, `IMPORTANT`. `readAt: null` berarti belum dibaca.

## 2. Inbox pengguna

Semua endpoint inbox memerlukan JWT valid. Pengguna hanya dapat membaca dan mengubah item dengan `recipientUserId === req.user.sub`. Admin tidak otomatis dapat membaca inbox pengguna lain.

### `GET /notifications`

Query: `status=ALL|UNREAD|READ` (default `ALL`), `category` (enum di atas), `priority=NORMAL|IMPORTANT`, `page` (default 1), `limit` (default 20, maksimum 100). Urutkan `createdAt DESC, _id DESC` agar paging stabil.

Respons `200`:

```json
{
  "items": [{
    "_id": "66f000000000000000000101",
    "category": "TASK_DUE_SOON",
    "priority": "IMPORTANT",
    "title": "Tenggat task mendekat",
    "message": "Task pemeriksaan ruang perlu diselesaikan besok.",
    "resource": { "type": "TASK", "id": "66f000000000000000000202", "route": "/app/tasks" },
    "readAt": null,
    "createdAt": "2026-11-22T01:00:00.000Z"
  }],
  "page": 1,
  "limit": 20,
  "total": 1,
  "unreadCount": 1
}
```

`unreadCount` selalu menghitung seluruh inbox pengguna tersebut, tidak mengikuti filter status/kategori.

### `GET /notifications/unread-count`

Respons `200`: `{ "count": 4 }`. Angka ini menjadi sumber badge header.

### `GET /notifications/:notificationId`

Respons `200`: satu item notifikasi. ID milik pengguna lain harus memberi `404`, agar keberadaan item tidak bocor.

### `PATCH /notifications/:notificationId/read`

Tanpa body. Mengisi `readAt` hanya jika masih null. Operasi idempotent dan mengembalikan item setelah perubahan (`200`). ID tidak ada atau bukan milik caller memberi `404`.

### `PATCH /notifications/read-all`

Tanpa body. Tandai semua unread milik caller saja. Operasi idempotent. Respons `200`: `{ "updatedCount": 4, "unreadCount": 0 }`.

## 3. Preferensi

### `GET /notifications/preferences`

JWT; hanya preferensi caller. Jika belum pernah disimpan, kembalikan default tanpa membuat dokumen. Default semua kategori aktif untuk `IN_APP` dan `EMAIL`.

```json
{
  "userId": "66f000000000000000000016",
  "timezone": "Asia/Jakarta",
  "categories": {
    "TASK_ASSIGNED": { "IN_APP": true, "EMAIL": true },
    "TASK_DUE_SOON": { "IN_APP": true, "EMAIL": true },
    "TASK_OVERDUE": { "IN_APP": true, "EMAIL": true },
    "REPORT_SUBMITTED": { "IN_APP": true, "EMAIL": true },
    "REPORT_REVISION_REQUESTED": { "IN_APP": true, "EMAIL": true },
    "REPORT_EVALUATION_COMPLETED": { "IN_APP": true, "EMAIL": true },
    "FOLLOW_UP_ASSIGNED": { "IN_APP": true, "EMAIL": true },
    "FOLLOW_UP_EVIDENCE_SUBMITTED": { "IN_APP": true, "EMAIL": true },
    "FOLLOW_UP_REVISION_REQUIRED": { "IN_APP": true, "EMAIL": true },
    "FOLLOW_UP_VERIFIED": { "IN_APP": true, "EMAIL": true }
  },
  "updatedAt": "2026-11-22T01:00:00.000Z"
}
```

In-app untuk pemberitahuan operasional wajib aktif. Hanya `EMAIL` yang dapat dimatikan pada implementasi awal; API tetap mengembalikan konfigurasi `IN_APP` agar UI dapat menjelaskan kebijakan. Alamat email berasal dari profil akun, bukan dari preference.

### `PATCH /notifications/preferences`

Patch parsial. Property yang tidak dikirim tidak berubah. Key kategori/kanal yang tak dikenal ditolak `400`.

```json
{
  "timezone": "Asia/Jakarta",
  "categories": {
    "TASK_DUE_SOON": { "EMAIL": false },
    "FOLLOW_UP_ASSIGNED": { "EMAIL": true }
  }
}
```

Respons `200`: object preferensi lengkap setelah merge. `timezone` harus nama zona waktu IANA valid.

## 4. Log dan email uji (Admin SPI)

### `GET /notifications/logs`

ADMIN_SPI saja. Query opsional: `status=PENDING|SENT|FAILED`, `channel=EMAIL`, `category`, `recipientUserId`, `page=1`, `limit=20` (maksimum 100). Respons memakai `{ "items": [], "page": 1, "limit": 20, "total": 0 }`.

Item log memiliki `notificationId`, `recipientUserId`, email penerima yang dimasking, `category`, `channel`, `status`, `attemptCount`, `lastAttemptAt`, `sentAt`, `errorCode` tersanitasi, `createdAt`. `idempotencyKey` hanya untuk log internal/debug terbatas; jangan bocorkan SMTP credential atau error mentah provider.

### `POST /notifications/test-email`

ADMIN_SPI saja, diberi rate limit. Body `{ "email": "admin@example.org" }`; email wajib divalidasi. Email uji tidak boleh membawa data pasien/laporan dan hasilnya dicatat di log.

Sukses `200`: `{ "sent": true, "logId": "66f000000000000000000301", "message": "Email uji berhasil dikirim." }`.

SMTP belum dikonfigurasi: `503`, kode `SMTP_NOT_CONFIGURED`. Provider gagal: `502`, kode `EMAIL_DELIVERY_FAILED` dan pesan aman. Error/provider response mentah hanya disimpan di log server yang terlindungi.

## 5. Pemicu internal dan penerima

Tidak ada endpoint publik untuk membuat notifikasi kepada pengguna lain. Domain service menerbitkan event setelah operasi berhasil; worker membuat inbox item dan mengantrekan delivery. Event minimal berisi `eventId`, `occurredAt`, kategori, penerima eksplisit, referensi resource, dan teks tampilan yang sudah disanitasi.

| Event domain | Kategori | Penerima |
|---|---|---|
| Task dibuat/assignee diganti | `TASK_ASSIGNED` | Assignee baru |
| Reminder H-1 dan satu jam sebelum tenggat | `TASK_DUE_SOON` | Assignee aktif; gunakan timezone jadwal |
| Task melewati tenggat | `TASK_OVERDUE` | Assignee aktif, sekali per tenggat |
| Laporan diserahkan | `REPORT_SUBMITTED` | Evaluator yang ditetapkan workflow |
| Revisi diminta | `REPORT_REVISION_REQUESTED` | Pembuat laporan |
| Evaluasi selesai/disetujui | `REPORT_EVALUATION_COMPLETED` | Pembuat laporan dan aktor workflow terkait |
| Follow-up dibuat/dialihkan | `FOLLOW_UP_ASSIGNED` | Assignee aktif |
| Bukti follow-up dikirim | `FOLLOW_UP_EVIDENCE_SUBMITTED` | Penanggung jawab verifikasi |
| Bukti perlu perbaikan | `FOLLOW_UP_REVISION_REQUIRED` | Assignee follow-up |
| Bukti diverifikasi | `FOLLOW_UP_VERIFIED` | Assignee dan pembuat laporan |

Email mengikuti preference. Inbox tetap dibuat ketika email dimatikan/gagal. Kegagalan email tidak menggagalkan transaksi domain. Untuk reminder, simpan jadwal/status di MongoDB dan gunakan BullMQ/Redis untuk scheduling. Terapkan retry terbatas, exponential backoff, timeout, dan transactional outbox atau pola setara agar event tidak hilang saat restart.

Idempotency unik minimal `eventId + recipientUserId` untuk inbox dan `eventId + recipientUserId + channel` untuk delivery. Reminder menambahkan occurrence dan waktu reminder. Jangan masukkan file, token, secret, kutipan sensitif, atau data pasien ke payload email/notifikasi.

## 6. Skema dan index MongoDB minimum

`notifications`:

- Field wajib `recipientUserId`, `eventId`, `category`, `priority`, `title`, `message`; `resource`, `readAt`, timestamps.
- Index `{ recipientUserId: 1, createdAt: -1, _id: -1 }` untuk paging.
- Index `{ recipientUserId: 1, readAt: 1, createdAt: -1 }` untuk daftar/unread count.
- Unique index `{ eventId: 1, recipientUserId: 1 }` untuk deduplikasi.

`notification_preferences`: `userId` unik, `timezone`, preference kategori/kanal, timestamps; jangan pernah simpan password atau SMTP credential.

`notification_logs` (koleksi existing): tambahkan field bertipe untuk `notificationId`, `recipientUserId`, `category`, `channel`, `status`, `attemptCount`, `lastAttemptAt`, `sentAt`, `errorCode`, `idempotencyKey`. Tambahkan unique index idempotency dan index `{ recipientUserId: 1, createdAt: -1 }` serta `{ status: 1, createdAt: -1 }`. Periksa duplikasi data sebelum membuat unique index; pertahankan log lama.

## 7. Error dan keamanan

Pertahankan format NestJS `{ "statusCode": 400, "message": "...", "error": "Bad Request", "code": "..." }`.

| Status | Kondisi |
|---|---|
| `400` | Filter, kategori, preference, atau email tidak valid |
| `401` | Token tidak valid/kedaluwarsa |
| `403` | Role tidak memiliki akses ke logs atau email uji |
| `404` | Notifikasi tidak ditemukan atau bukan milik caller |
| `429` | Rate limit email uji |
| `502` | Pengiriman provider gagal |
| `503` | SMTP belum dikonfigurasi |

Kepemilikan inbox/preferences selalu ditentukan dari JWT `req.user.sub`, bukan `recipientUserId` body/query. Log dan email uji ADMIN_SPI saja. Masking email log, validasi DTO, audit aktivitas admin, dan penyaringan field sensitif wajib diterapkan.

## 8. Tipe yang dipakai frontend

```ts
type NotificationCategory =
  | 'TASK_ASSIGNED' | 'TASK_DUE_SOON' | 'TASK_OVERDUE'
  | 'REPORT_SUBMITTED' | 'REPORT_REVISION_REQUESTED' | 'REPORT_EVALUATION_COMPLETED'
  | 'FOLLOW_UP_ASSIGNED' | 'FOLLOW_UP_EVIDENCE_SUBMITTED'
  | 'FOLLOW_UP_REVISION_REQUIRED' | 'FOLLOW_UP_VERIFIED'

interface NotificationItem {
  _id: string
  category: NotificationCategory
  priority: 'NORMAL' | 'IMPORTANT'
  title: string
  message: string
  resource?: { type: string; id: string; route: string }
  readAt: string | null
  createdAt: string
}

interface NotificationPage {
  items: NotificationItem[]
  page: number
  limit: number
  total: number
  unreadCount: number
}
```

Polling unread count cukup untuk tahap awal; WebSocket/SSE opsional dan tidak menggantikan REST/RBAC.

## 9. Kriteria penerimaan

1. User hanya melihat inbox sendiri; filter mendukung Semua/Belum Dibaca/Dibaca, kategori, dan prioritas.
2. Badge unread count benar; aksi baca satu/semua idempotent dan hanya memengaruhi user aktif.
3. Deep link menuju task/laporan/follow-up yang diizinkan dan endpoint tujuan mengulang pemeriksaan akses.
4. Preference tersimpan per-user, patch parsial, validasi timezone, dan kontrol email per kategori.
5. Assignment, perubahan evaluasi, reminder tenggat, dan event follow-up membuat inbox tanpa duplikasi.
6. Email mengikuti preference; retry/log aman; kegagalan email tidak membatalkan workflow atau menghilangkan inbox.
7. Hanya Admin SPI membaca delivery logs dan mengirim email uji; email uji tervalidasi/rate-limited.
8. Test mencakup RBAC/ownership, filter/pagination, unread count, read-one/read-all, preference default/merge, recipient mapping, dedupe, retry, serta kegagalan SMTP.
