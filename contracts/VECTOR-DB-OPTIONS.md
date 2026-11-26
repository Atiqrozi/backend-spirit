# Opsi Vector Database Gratis untuk SPI

"Gratis" perlu dibedakan: perangkat lunak self-hosted dapat tanpa biaya lisensi, tetapi tetap memakai komputer/server dan listrik. Free tier cloud gratis untuk mencoba, tetapi batas resource dan persyaratannya dapat berubah. NVIDIA embedding/reranking API memiliki kuota dan ketentuan layanan terpisah dari biaya vector database.

## Rekomendasi untuk proyek ini

### Development lokal: Qdrant dengan Docker

Qdrant adalah opsi yang saya rekomendasikan untuk membuat prototype RAG lokal. Engine-nya open source Apache 2.0 dan dapat dijalankan sendiri dengan Docker tanpa biaya lisensi. Ia menyimpan vector dan payload metadata bersama, cocok dengan kontrak chunk metadata SPI. Anda mengelola container, backup, keamanan, dan kapasitasnya sendiri. [Qdrant local quickstart](https://qdrant.tech/documentation/quickstart/) · [Qdrant deployment dan lisensi](https://qdrant.tech/lp/open-source/)

Contoh menjalankan untuk development (butuh Docker Desktop aktif):

```cmd
docker run -p 6333:6333 -p 6334:6334 -v qdrant_storage:/qdrant/storage qdrant/qdrant
```

Jangan publikasikan port service ini ke internet tanpa autentikasi/TLS. Simpan metadata minimal yang dibutuhkan untuk retrieval dan batasi akses berdasarkan role pada backend.

### Jika ingin paling sederhana dengan stack sekarang: MongoDB Atlas Vector Search

Backend SPI sudah memakai MongoDB Atlas, sehingga menyimpan vector dalam MongoDB dapat menghindari layanan database tambahan. Dokumentasi Atlas mendukung pembuatan vector index pada Free cluster dan menyarankan Free cluster untuk pengujian lokal/query; Free cluster memiliki batas total storage 0.5 GB, tidak punya backup Atlas, resource tidak dapat diatur, dan tidak mendukung dedicated Search Nodes. Karena itu gunakan untuk proof of concept, bukan anggapan kapasitas production. [Atlas Vector Search deployment options](https://www.mongodb.com/docs/vector-search/deployment/deployment-options/) · [Atlas Free cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)

### Alternatif: PostgreSQL + pgvector

`pgvector` adalah extension open source dengan exact/approximate nearest-neighbor search, HNSW, cosine distance, dan hybrid search. Bisa dijalankan gratis di mesin sendiri melalui Docker. Untuk SPI ini menambah PostgreSQL selain MongoDB, sehingga saya tidak menyarankannya sebagai pilihan pertama kecuali tim memang ingin/siap mengoperasikan Postgres. [pgvector official repository](https://github.com/pgvector/pgvector)

## Pilihan tahap berikutnya

1. Mulai dengan **Qdrant Docker lokal** untuk implementasi API kontrak dan uji koleksi/index secara terkontrol.
2. Bandingkan hasil dan beban operasional dengan **Atlas Vector Search M0** bila ingin mempertahankan satu database saja.
3. Putuskan target deployment dan backup sebelum memasukkan dokumen SPI sensitif ke layanan cloud. Free tier bukan pengganti kebijakan retensi, backup, dan kontrol akses.

Tetapkan satu vector store untuk setiap environment. Simpan `documentId`, `documentVersionId`, `pageStart`, `pageEnd`, `section`, `chunkId`, dan `embeddingModel` di payload; jangan menyimpan PDF/Base64 di vector database.
