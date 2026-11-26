# MongoDB Atlas Vector Search setup

The backend stores passage text, its embedding, and traceability metadata in the `document_chunk_vectors` collection. MongoDB remains the vector store and application database; no separate vector database service is required.

## Create the Atlas index

1. Connect the backend to an Atlas cluster that supports Vector Search. A Free cluster is suitable for prototyping and has limited shared resources/storage.
2. In Atlas, open the `spi_compliance` database and create the `document_chunk_vectors` collection (Mongoose can also create it on first insert).
3. Create a **Vector Search** index on that collection named `spi_chunks_vector_idx`.
4. Paste the field definition from [`spi-chunks-vector-index.json`](spi-chunks-vector-index.json).
5. Wait for the index state to become `READY` before calling retrieval.

The index uses cosine similarity and 2048 dimensions, matching NVIDIA `nvidia/nemotron-3.5-embed-1b`. If you change embedding model or dimensions, create a new index/collection and re-index the corpus; vectors from different embedding spaces must not be mixed.

## API routes

- `POST /api/v1/indexing/chunks` — accepts chunk text and provenance metadata, calls NVIDIA Embeddings using `input_type: passage`, and upserts vectors into Atlas.
- `POST /api/v1/retrieval/search` — embeds the query using `input_type: query`, runs Atlas `$vectorSearch`, and optionally reranks up to 50 returned candidates through NVIDIA Nemotron Rerank.

Both routes require a backend JWT Bearer token. Indexing permits `ADMIN_SPI` and `ANGGOTA_SPI`; retrieval requires authentication. Apply the application's resource-level authorization before production use so a caller only receives source documents they are allowed to read.
