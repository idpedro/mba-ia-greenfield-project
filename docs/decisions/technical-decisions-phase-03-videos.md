---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-29
scope_description: "Backend foundation for video upload and processing: message queue technology, S3-compatible storage usage (container, SDK, bucket/key layout, endpoints), 10GB direct-to-storage upload protocol and limits, upload-completion trigger, video status lifecycle and failure policy, worker topology, FFmpeg/ffprobe integration and media input access, thumbnail frame policy, unique video URL identifier, streaming/download delivery, and playback access policy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module, the `videos` table migration, the storage/queue integration, the video worker entrypoint, and the new Compose services (object storage, queue broker, worker). All TDs below land here.
- `next-frontend/` — no open decision in this document. The video UI (upload screen, player, download button) is explicitly out of scope for Phase 03 (`docs/desafio-fase-03.md`: "a interface de vídeo não faz parte do escopo desta fase"). The Cross-layer TDs below (TD-05, TD-07, TD-14, TD-15) fix the HTTP contract the frontend will consume in a later phase; they are decided once here and are not re-split per layer.

**Inherited constraints (not reopened):**

- Object storage is S3-compatible — S3 in production, an S3-compatible container locally — RustFS per TD-02 (originally "S3 or MinIO" in `docs/diagrams/software-arch.mermaid`, `docs/desafio-fase-03.md`). What is decided here is *how* to use it, not *which* API.
- Config via `@nestjs/config` + Joi + namespaced `registerAs` (`phase-01-configuracao-base/TD-01..TD-04`) — every new env key below goes into `env.validation.ts`, a `registerAs` namespace, `.env.example` and `compose.yaml`.
- Request validation with `class-validator` (`phase-02-auth/TD-06`), error contract via the custom Domain Exception Filter (`phase-02-auth/TD-07`), global JWT guard with custom guards (`phase-02-auth/TD-02`), rate limiting with `@nestjs/throttler` (`phase-02-auth/TD-08`).
- OpenAPI via `@nestjs/swagger` + exported `openapi.json` (`openapi-docs-nestjs/TD-01..TD-02`) — new endpoints are documented the same way.
- Frontend is a strict BFF with a single server-only `API_URL` (`next-frontend-config-base/TD-03`). Note: the browser still talks **directly to object storage** for upload/stream bytes (architecture diagram: `Frontend → Object Storage: Streams`); the BFF carries only the small JSON control calls.

**Installed versions checked:** `@nestjs/common` 11.1.16, `typeorm` ^0.3.28, `pg` ^8.20, Node `25.6.0-slim` image (`Dockerfile.dev`). Candidates checked on npm on 2026-10-29: `bullmq` 6.5.1, `@nestjs/bullmq` 11.0.5 (peer `@nestjs/* ^10||^11`, `bullmq ^3..^6`) / 12.0.0 (peer adds `^12`), `pg-boss` 12.38.0, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 3.1160.0, `minio` 8.0.7, `fluent-ffmpeg` 2.1.3 (**deprecated on npm: "Package no longer supported"**). Exact pins are fixed later by `/plan-resolve` in `library-refs.md`.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as `TBD`. The API must publish a processing job when an upload completes and a separate worker must consume it. Jobs are long-running (ffprobe + frame extraction on files up to 10GB), must survive worker restarts, and need retry/backoff. This is the main open stack decision of the phase.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed queue. The API registers a `Queue` and adds jobs; the worker process hosts a `@Processor()` class extending `WorkerHost`. New Compose service: `redis`.
- **Pros:** Official Nest integration (`BullModule.forRootAsync` / `registerQueue` / `@Processor`), already compatible with Nest 11. Built-in `attempts` + exponential `backoff`, `UnrecoverableError` to skip retries, stalled-job detection with locks (a crashed worker's job is re-delivered), custom `jobId` for idempotent enqueue, per-worker `concurrency`. Clear separation producer (API) / consumer (worker) — matches the diagram's `queue → worker`.
- **Cons:** New infrastructure (Redis) to run, monitor and persist (AOF/RDB). Enqueue is not transactional with the PostgreSQL write (dual-write between DB commit and `queue.add`) — must be handled by ordering + idempotency (see TD-07/TD-09).

### Option B: pg-boss on the existing PostgreSQL
- Job queue implemented in a dedicated Postgres schema using `SKIP LOCKED`. API calls `boss.send()`, worker calls `boss.work()`.
- **Pros:** Zero new infrastructure — reuses `db`. Enqueue can share the same Postgres transaction as the video status update (no dual-write). Built-in `retryLimit`/`retryDelay`/`retryBackoff`, dead-letter queues, `singletonKey`.
- **Cons:** No official Nest module — needs a hand-written provider/lifecycle wrapper and processor discovery. Adds polling/`NOTIFY` load and job-table churn to the main OLTP database. The challenge frames queue as *new* infra alongside storage and worker; a DB-backed queue is a weaker demonstration of the decoupled `queue` container in the diagram.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport or `amqplib`)
- AMQP broker; API publishes to an exchange, worker consumes from a durable queue with manual ack.
- **Pros:** Real message broker with routing, durable queues, DLX. Nest has a first-party transport.
- **Cons:** The Nest RMQ transport is message/event oriented — retries with backoff, delayed redelivery and job state are not built in (must be built with DLX + TTL). No job-progress/state API. Heavier container and more concepts for a single job type.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option with an official Nest 11 integration *and* job semantics (retry/backoff, stalled-job recovery, unrecoverable errors, idempotent `jobId`) out of the box, which is exactly what long FFmpeg jobs need; the cost is one Redis container, and the dual-write gap is closed cheaply with `jobId = videoId` plus the status rules of TD-07/TD-09. pg-boss is a legitimate alternative if avoiding new infra outweighs the missing Nest integration.

**Decision:** A (BullMQ + Redis)
**Libraries:** bullmq@^6.5.1, @nestjs/bullmq@^11.0.5

---

## TD-02: Local S3-Compatible Storage Container

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project points to "S3 or MinIO", and the challenge assumes MinIO in Docker. However, MinIO stopped publishing community Docker images in October 2025, the community edition is now distributed as source only, and the `minio/minio` repository is marked as no longer maintained. The S3 API is not reopened; what must be decided is which container image provides it in `compose.yaml` for dev and tests (production uses AWS S3).

**Options:**

### Option A: Last upstream `minio/minio` image, pinned by tag/digest
- Use the final community `RELEASE.*` tag from Docker Hub, pinned (never `latest`), plus `minio/mc` (or the same image's `mc`) for bucket bootstrap.
- **Pros:** Exactly what the challenge and diagram describe; vast documentation; console UI on `:9001`; supports presigned multipart, Range GETs and `response-content-disposition`.
- **Cons:** Frozen image — no security fixes going forward. Acceptable only because it is dev/test-only, never deployed.

### Option B: Chainguard-maintained MinIO image (`cgr.dev/chainguard/minio`)
- Community rebuild of MinIO from source, kept patched by Chainguard.
- **Pros:** Same MinIO behavior and docs, but still receiving patches.
- **Cons:** Third-party rebuild; free tier tracks `latest` only, so reproducibility requires digest pinning and periodic manual bumps. Minimal image (no shell), so bucket bootstrap needs a separate `mc` container.

### Option C: RustFS (`rustfs/rustfs`, pinned) + `rustfs/rc` for bucket bootstrap
- Apache-2.0, actively maintained S3-compatible server positioned as a MinIO replacement. S3 API on `:9000`, console on `:9001`, `/health` endpoint for the Compose healthcheck; env `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `RUSTFS_VOLUMES`; CORS via `RUSTFS_CORS_ALLOWED_ORIGINS` or `PutBucketCors`. Clients must use path-style addressing (`forcePathStyle: true`).
- **Pros:** Maintained and patched (unlike Option A), permissive license, near drop-in operational model (same ports, console, `mc`-like `rc` CLI). Documented support for multipart create/upload-part/complete/list/abort, presigned GET/PUT, range reads, CORS and lifecycle.
- **Cons:** Younger project. Its S3 compatibility page does **not** explicitly document presigned `UploadPart` URLs, `ListParts` (it notes "some multipart upload listing and part-lookup edge cases" outside the default compatibility gate), `response-content-disposition` overrides or the `AbortIncompleteMultipartUpload` lifecycle rule. Docs are inconsistent on the image name/version (`rustfs/rustfs:1.0.4` in the README vs `rustfs/rustfs-x86-musl:v2.3.1` in Compose examples). Departs from the "S3 or MinIO" wording of the diagram/challenge (the S3 API contract is preserved).

### Option D: SeaweedFS (S3 gateway)
- Apache-2.0, mature distributed file store with a built-in S3 gateway, single binary.
- **Pros:** Long production track record; actively maintained.
- **Cons:** S3 is a gateway over its filer rather than the core model; coverage of presigned multipart parts, `ListParts` and `response-*` overrides not verified for this stack; operationally less MinIO-like.

_Considered and discarded:_ **Garage** (cluster layout step even for one node; older docs list lifecycle as missing and CORS tied mainly to the web endpoint), **LocalStack** (since release 2026.03.0 requires an auth token even for free use — adds an account-bound secret to a repo evaluators clone; the tokenless `s3-community-archive` image is frozen), **S3Mock / S3Proxy** (test doubles — the challenge requires real storage exercised by the tests).

**Recommendation:** **Option A (pinned last upstream MinIO image)** — the container only backs local dev and the integration/e2e suites, while production targets AWS S3, so a frozen-but-pinned image costs no production risk and keeps the project aligned with the diagram and the challenge; Option B is the drop-in fallback if a patched image becomes necessary.

**Note:** Decision deliberately diverges from the Recommendation — the user prefers a maintained, permissively licensed server over a frozen MinIO image; the S3 API contract (TD-03..TD-07, TD-12, TD-15) is unchanged, only the local container differs. Because RustFS's docs do not explicitly cover every operation this phase depends on, the plan must include an early **storage compatibility gate** (integration tests against the real `rustfs` Compose service, run before any upload/streaming SI builds on it) covering: presigned `UploadPart` PUT from a non-SDK HTTP client, `ListParts` after a partial upload, `CompleteMultipartUpload` + `HeadObject` size, Range GET → `206`, presigned GET with `ResponseContentDisposition`, CORS preflight exposing `ETag`, and ffprobe/ffmpeg reading a presigned URL. Fallback if any check fails: Option A (pinned MinIO), with no application-code change. Exact image name/tag is pinned in `/plan-resolve`.

**Decision:** C (RustFS)
**Libraries:** —

**Revisions:**
- 2026-10-30 — Local storage image pinned to `rustfs/rustfs:1.0.4` (latest stable tag on Docker Hub as of 2026-10-30; `-glibc` variant not used). Rationale: resolves the pending image pin (phase-03-videos validation OQ-1); an exact tag keeps the storage compatibility gate reproducible.
- 2026-10-30 — Storage compatibility gate extended with one more check: `PutBucketLifecycleConfiguration` with an `AbortIncompleteMultipartUpload` rule is accepted by RustFS and read back via `GetBucketLifecycleConfiguration`. Rationale: resolves phase-03-videos validation IC-2 — TD-08's stale-upload backstop depends on this bucket feature, which RustFS's docs do not explicitly cover; failing it triggers the same fallback (pinned MinIO, no application-code change).


---

## TD-03: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Both the API (initiate/sign/complete multipart uploads, sign GET URLs, delete objects) and the worker (read source, write thumbnail) talk to storage. The client must work against RustFS (TD-02) locally and AWS S3 in production with configuration changes only.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular official SDK. `S3Client({ endpoint, forcePathStyle: true, region, credentials })` for the local S3-compatible server (path-style is required by RustFS); `getSignedUrl(client, new UploadPartCommand(...))` for presigned parts.
- **Pros:** Production target is S3, so the same code path runs in prod. Every needed command is first-class (`CreateMultipartUpload`, `UploadPart`, `ListParts`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `HeadObject`, `GetObject` with `ResponseContentDisposition`). Strong TypeScript types. Actively released.
- **Cons:** Verbose command-object API; larger dependency footprint than a single client.

### Option B: MinIO JS SDK (`minio`)
- MinIO's own S3-compatible client (`Client.presignedUrl`, `putObject`, etc.).
- **Pros:** Concise API; works with AWS S3 as well.
- **Cons:** Presigning individual multipart parts requires the low-level `presignedUrl('PUT', ..., { partNumber, uploadId })` path and manual multipart orchestration with fewer typed helpers. Tied to a vendor whose server is no longer maintained as open source (TD-02), which weakens the long-term case for its SDK.

**Recommendation:** **Option A (AWS SDK v3)** — production storage is S3, so using AWS's own SDK keeps dev and prod on one code path, and it exposes every multipart/presign command TD-05 and TD-15 need as typed commands.

**Decision:** A (AWS SDK v3)
**Libraries:** @aws-sdk/client-s3@^3.1160.0, @aws-sdk/s3-request-presigner@^3.1160.0

---

## TD-04: Bucket Layout, Object Key Scheme and Storage Endpoint Contract

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Bucket names and key patterns are written by the API (upload target), the worker (thumbnail output) and the Compose bootstrap (bucket creation), and the env keys appear in `env.validation.ts`, `.env.example` and `compose.yaml` — a cross-component contract. In addition, **presigned URLs are signed for a specific host**: the API reaches storage as `http://rustfs:9000` (Compose service name, per CLAUDE.md Docker Networking), but a browser cannot resolve `rustfs`. URLs handed to clients must therefore be signed against a public endpoint (e.g., `http://localhost:9000` in dev, the S3 endpoint in prod) while server-side calls keep the internal one.

**Options:**

### Option A: Single private bucket, per-video key prefix; split internal/public endpoints
- One bucket (e.g., `streamtube-videos`), keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Env: `S3_ENDPOINT` (internal, `http://rustfs:9000`), `S3_PUBLIC_ENDPOINT` (signing host for client URLs), `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`. Two `S3Client` instances: internal for operations, public for presigning.
- **Pros:** All artifacts of a video live under one prefix — deleting a video is one prefix delete; one bucket to create, one CORS/lifecycle config. Keys never contain user input (only server-generated ids).
- **Cons:** Thumbnails and originals share bucket-level policies; a future need for different lifecycle/visibility per type requires prefix-scoped rules.

### Option B: Separate buckets per asset type
- `streamtube-videos` for originals and `streamtube-thumbnails` for images (keys `{videoId}.ext`), same endpoint split as Option A.
- **Pros:** Independent policies per type (e.g., thumbnails could become public-read/CDN-backed later without touching videos).
- **Cons:** Two buckets to bootstrap and configure per environment, two env keys; deleting a video touches two buckets.

### Option C: Single endpoint, proxied through the API host
- Keep one `S3_ENDPOINT` and never expose storage URLs; the API streams everything.
- **Pros:** No public storage endpoint to configure.
- **Cons:** Contradicts TD-05/TD-15's direct-to-storage traffic (the 10GB upload would pass through the API — an automatic-fail criterion in the challenge).

**Recommendation:** **Option A** — one private bucket with per-video prefixes keeps cleanup and bootstrap trivial for a phase that has a single owner of both assets, and the explicit `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` split is mandatory for any presigned-URL design inside Docker; Option B only pays off once thumbnails need a different visibility, which is a Phase 04+ concern.

**Decision:** A (Single private bucket, per-video prefixes, internal/public endpoints)

---

## TD-05: 10GB Upload Protocol (Direct-to-Storage)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The plan requires 10GB uploads "sem travar o sistema" and resumable after connection failures (§4 Pontos de Atenção). Passing the file through the API is an automatic fail in the challenge. A single S3 `PutObject` (and presigned POST) is capped at **5GB**, so 10GB requires a multipart mechanism. The choice fixes the handshake sequence on both sides: backend endpoints and the client's chunking loop. Depends on TD-03/TD-04.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (API orchestrates, bytes go to storage)
- `POST /videos` creates the draft + `CreateMultipartUpload` and returns `videoId`, `uploadId`, `partSize`, `partCount`. Client requests presigned `UploadPart` URLs (batch), `PUT`s parts directly to storage collecting `ETag`s, then calls a complete endpoint. Resume: client asks the API for already-uploaded parts (`ListParts`) and uploads the rest.
- **Pros:** API handles only small JSON calls — zero file bytes through Nest. Native S3 feature; same flow on RustFS and S3 (RustFS presigned `UploadPart`/`ListParts` verified by the TD-02 compatibility gate). Resumable per part; parallel part uploads. Fits the diagram (frontend ↔ storage directly).
- **Cons:** More endpoints/state (uploadId stored on the video). Browser needs CORS on storage with `ETag` exposed. Client logic is more complex than a single PUT.

### Option B: tus resumable protocol (`@tus/server` + `@tus/s3-store`)
- A tus server receives chunks (PATCH with offsets) and forwards them to S3 multipart.
- **Pros:** Standardized resumable protocol with mature clients (`tus-js-client`, Uppy); offset-based resume is simple for the client.
- **Cons:** Every byte flows through the tus server — if mounted in the API, 10GB passes through Nest (the exact anti-pattern the challenge forbids); isolating it needs yet another service. Extra dependency stack and non-S3 protocol to document.

### Option C: Single presigned `PUT` URL
- API returns one presigned `PutObject` URL; client uploads the whole file.
- **Pros:** Simplest possible client and backend.
- **Cons:** **Fails the requirement:** S3 single-PUT limit is 5GB; no resume — a dropped connection restarts 10GB from zero.

**Recommendation:** **Option A (presigned S3 multipart)** — it is the only option that keeps every file byte off the API, supports 10GB (multipart allows up to 10,000 parts) and resumes per part, using a native S3 feature available on both RustFS (subject to the TD-02 gate) and AWS S3.

**Decision:** A (Presigned S3 multipart, direct to storage)

---

## TD-06: Upload Limits and Validation Policy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** With direct-to-storage uploads (TD-05), the API never sees the bytes, so size/type must be enforced elsewhere. Values here (max size, part size, URL TTL, accepted types) appear in the DTO validation, the env/config schema, the client's chunking loop and the worker's media check. Depends on TD-05.

**Options:**

### Option A: Trust declared metadata only
- Client declares `fileName`, `size`, `mimeType` on `POST /videos`; API validates the declaration (≤ max, allowed MIME) and signs URLs.
- **Pros:** Simplest.
- **Cons:** A client can declare 1MB and upload 10GB+ (presigned part URLs do not bound part size) or upload non-video content; the system discovers it only when processing fails.

### Option B: Declared metadata + server-side verification at completion + ffprobe as final authority
- Validate the declaration on initiate; API computes `partSize` (server-defined) and `partCount`, signs only part numbers `1..partCount`. On complete, API calls `HeadObject` and rejects (aborts/deletes, marks failed) if `ContentLength` > max or ≠ declared. The worker's ffprobe (TD-11) is the authority on "is this a video": no video stream → unrecoverable failure.
- **Pros:** Bounds abuse at three points without touching bytes. Server-chosen part size keeps the part count well under S3's 10,000 limit (e.g., 10 GiB / 64 MiB = 160 parts). Real content validation where it can actually be done.
- **Cons:** Oversized uploads are detected after the bytes land (storage cost until cleanup). More rules to test.

### Option C: Option B plus per-part size enforcement in signed URLs
- Additionally sign `Content-Length` per part URL so storage rejects oversized parts.
- **Pros:** Rejects oversize at upload time.
- **Cons:** Signing `Content-Length` makes each URL valid for only one exact size (last part differs), increasing client/server coupling; behavior must be verified on both RustFS and S3. Marginal gain over B's completion check.

**Recommendation:** **Option B** — the completion `HeadObject` check plus ffprobe validation enforce size and type without routing bytes through the API; proposed values for `/plan-resolve` to confirm: max **10 GiB**, server-defined part size **64 MiB**, presigned URL TTL **1h** (re-signable on resume), accepted MIME `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`.

**Decision:** B (Declared metadata + HeadObject on complete + ffprobe)
**Libraries:** —

**Revisions:**
- 2026-10-30 — Proposed limits confirmed: max size **10 GiB**, server-defined part size **64 MiB**, presigned part URL TTL **1h** (re-signable on resume), accepted MIME `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`. Rationale: resolves phase-03-videos validation OQ-2; values flow into DTO validation, the env/config schema and the client chunking loop.

---

## TD-07: Upload Completion → Processing Trigger

**Scope:** Cross-layer

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Something must notice that the upload finished, finalize the multipart object and enqueue the processing job. This decides whether the client signals completion (an endpoint in the contract) or storage emits an event. Depends on TD-01, TD-05.

**Options:**

### Option A: Client calls a complete endpoint; API completes, updates status and enqueues
- `POST /videos/:id/upload/complete` with the `{ partNumber, etag }` list. API calls `CompleteMultipartUpload`, verifies (TD-06), sets status to processing, commits, then `queue.add('process', { videoId }, { jobId: videoId })`.
- **Pros:** Same flow on RustFS and S3; synchronous error feedback to the client (bad ETags, oversize). Completing multipart *requires* the ETag list the client holds, so a client call is needed anyway. Idempotent: repeating the call or enqueue is safe with `jobId = videoId`.
- **Cons:** If the client never calls complete, the video stays pending (handled by TD-08's stale-upload rule). Dual-write DB→queue must be ordered (commit first, then enqueue; a failed enqueue leaves status recoverable by retrying complete).

### Option B: Storage event notifications
- Configure local bucket notifications on the S3-compatible server (to Redis/webhook) and S3 Event Notifications (SQS/EventBridge) in prod; a listener enqueues the job on `ObjectCreated:CompleteMultipartUpload`.
- **Pros:** Completion detected even if the client disappears right after finishing.
- **Cons:** Different wiring per environment (local server vs AWS) — the dev setup no longer mirrors prod. The client still has to complete the multipart upload with its ETags, so it calls storage anyway. More infra to test.

### Option C: Worker/scheduler polls storage for finished uploads
- A scheduled job scans pending videos and checks `HeadObject`.
- **Pros:** No extra contract endpoint.
- **Cons:** Latency and wasted calls; still needs someone to call `CompleteMultipartUpload`. Weakest option.

**Recommendation:** **Option A (explicit complete endpoint)** — S3 multipart completion already requires the client's ETag list, so a single complete endpoint that finalizes, verifies and enqueues is the simplest flow that works the same on RustFS and S3 and gives the client immediate errors.

**Decision:** A (Explicit complete endpoint)

---

## TD-08: Video Status Model and Draft Pre-Registration

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The video row must exist as a draft as soon as the upload starts, and its status must reflect upload → processing → ready/failed in the database (acceptance criterion). Phase 04 adds a separate "rascunho → publicação" flow and public/unlisted visibility. The status design decided now determines whether Phase 04 extends or reworks this column, and it is cited by the migration, entity, worker, DTOs and OpenAPI enum.

**Options:**

### Option A: Single `status` enum covering everything
- `status`: `draft` (row created, uploading) → `processing` → `ready` | `failed`; Phase 04 would add `published`.
- **Pros:** One column; matches the challenge's example wording literally.
- **Cons:** Conflates two independent axes: a video can be `ready` *and* still a draft (unpublished), or `failed` and a draft. Phase 04 would need states like `ready_draft`/`published` or a rework of this enum and its migration.

### Option B: Two orthogonal fields — `processing_status` + `publication_status`
- `processing_status`: `pending_upload` → `processing` → `ready` | `failed` (with `failure_reason`). `publication_status`: created as `draft` (Phase 04 adds `published`; visibility is a separate Phase 04 field).
- **Pros:** Each axis has one owner (upload/worker vs. Phase 04 editing). Phase 04 only adds an enum value and transitions, no rework. Queries stay simple (`processing_status = 'ready' AND publication_status = 'published'`).
- **Cons:** Two enums/columns now; Phase 03 only ever writes `draft` to the second one.

### Option C: Single enum + boolean `is_draft`
- `status` (`uploading`, `processing`, `ready`, `failed`) + `is_draft boolean default true`.
- **Pros:** Same separation as B with a lighter second field.
- **Cons:** A boolean cannot grow (scheduled, archived…); Phase 04's draft→publish flow would likely replace it.

**Recommendation:** **Option B** — the project plan explicitly has a draft→publish flow in Phase 04 that is independent of processing outcome, so separating `processing_status` from `publication_status` now avoids an enum rework later; the stale-upload rule (videos stuck in `pending_upload` beyond the URL TTL window are marked failed and their multipart upload aborted) should be resolved in `/plan-resolve`.

**Decision:** B (processing_status + publication_status)
**Libraries:** —

**Revisions:**
- 2026-10-30 — Stale-upload rule decided: an hourly BullMQ repeatable job marks videos still in `pending_upload` 24h after creation as `failed` with `failure_reason = upload_expired` and calls `AbortMultipartUpload` for their open upload; the bucket also gets an `AbortIncompleteMultipartUpload` lifecycle rule (2 days) as a backstop. Rationale: resolves phase-03-videos validation OQ-3; the 24h window comfortably exceeds the 1h re-signable URL TTL (TD-06) so resumed uploads are not killed.

---

## TD-09: Processing Failure and Retry Policy

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing can fail transiently (storage/network hiccup, worker crash mid-job) or permanently (corrupt file, no video stream, unsupported codec). The policy decides job options, which errors are retried and how the final failure is written to the DB. Depends on TD-01, TD-08.

**Options:**

### Option A: Bounded retries with backoff; permanent errors skip retries; terminal `failed`
- Job options `attempts: 3`, exponential backoff. Media-validation errors throw an unrecoverable error (BullMQ `UnrecoverableError`) → no retry. When the last attempt fails, the worker writes `processing_status = failed` + `failure_reason`. Processing is idempotent per `videoId` (overwrites thumbnail key/metadata).
- **Pros:** Transient issues heal automatically; bad files fail fast. DB always ends in a terminal state the owner can see.
- **Cons:** Requires classifying errors in the worker; needs a "final attempt" hook (`job.attemptsMade` / `failed` event).

### Option B: No retries; fail immediately
- `attempts: 1`; any error marks the video failed.
- **Pros:** Simplest.
- **Cons:** A single network blip permanently fails a 10GB upload's processing; the user must re-upload since there is no reprocess endpoint in scope.

### Option C: Retries + dead-letter queue + manual reprocess
- Like A, but exhausted jobs go to a DLQ and an admin/owner endpoint re-enqueues them.
- **Pros:** Operational recovery without re-upload.
- **Cons:** Reprocess endpoint and DLQ handling are not phase capabilities — scope creep.

**Recommendation:** **Option A** — bounded retries with backoff cover transient storage/worker failures while unrecoverable media errors fail fast, and the terminal `failed` + reason satisfies the "pronto/erro reflected in the DB" criterion without adding an out-of-scope reprocess feature.

**Decision:** A (Bounded retries + unrecoverable media errors + terminal failed)

---

## TD-10: Video Worker Runtime Topology

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The diagram defines a separate "Video Worker (FFmpeg)" container that reads/writes storage and updates the DB. The decision is where its code lives and how it runs, affecting `compose.yaml`, Dockerfiles, `package.json` scripts and how entities/config are shared with the API.

**Options:**

### Option A: Modular monolith — same `nestjs-project` codebase, bounded modules, two entrypoints
- Three modules with explicit responsibilities: `videos/` (domain: entity, upload orchestration, stream/download endpoints, enqueues the job), `storage/` (S3 infrastructure: internal/public clients, presigning; no business rules) and `video-processing/` (queue consumer: BullMQ processor, ffprobe/ffmpeg wrapper, thumbnail). Two entrypoints: `src/main.ts` (HTTP API — imports `VideosModule` + `StorageModule`, never `VideoProcessingModule`) and `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`, no HTTP — imports `VideoProcessingModule` + `StorageModule`). Compose service `video-worker` runs the second entrypoint from the same source, in an image with `ffmpeg`. Module boundaries enforced by convention plus a lint rule forbidding deep imports into another module's internals; the `videos` ↔ `video-processing` contract is the job payload (`{ videoId }`) and the status enums.
- **Pros:** Single Responsibility per module (processing never leaks into the API process; S3 isolated in `storage/`) without new repo tooling. No duplication of the `Video` entity, config or storage client; one test toolchain (Jest, tsc, lint) and one DoD. Separate process/container → FFmpeg CPU never competes with the API event loop; independently scalable (`replicas`). Clean seam for extracting a package later if ever needed.
- **Cons:** Boundaries are enforced by convention + lint, not by package visibility. API and worker share a release cycle and a `package.json`; the API image would also carry `ffmpeg` unless images are split by Dockerfile target.

### Option B: npm workspace package (`packages/video-processing`)
- Same split as A, but `video-processing` becomes a workspace package with its own `package.json`, consumed by a worker entrypoint.
- **Pros:** Physical boundary — only the package's public exports are visible; isolated dependencies (ffmpeg wrapper never in the API's dependency graph).
- **Cons:** Introduces monorepo tooling the repo does not have today (npm workspaces, `tsconfig` references/paths, Jest and `nest-cli` adjustments, bind-mount/Docker changes) — a repo-wide decision of its own. The `Video` entity, needed by both sides since the worker updates the DB, must move to a third shared package or be duplicated. Two build/test pipelines under the DoD.

### Option C: Separate subproject (`video-worker/`) with its own package
- Standalone Node (or other language) project consuming the queue and writing the DB directly.
- **Pros:** Fully independent deploy and dependencies; smallest worker image.
- **Cons:** Duplicates entity/schema knowledge and config validation, or requires a new shared package (monorepo tooling not present today). Second test/lint/tsc pipeline; DoD and CLAUDE.md commands only cover `nestjs-project`.

### Option D: In-process worker inside the API
- Register the processor in the API process itself.
- **Pros:** Zero extra services.
- **Cons:** FFmpeg-driven jobs share CPU/memory with request handling — contradicts "sem travar o sistema" and the diagram's separate container.

**Recommendation:** **Option A** — a modular monolith with bounded `videos` / `storage` / `video-processing` modules and two entrypoints gives the process isolation the diagram requires and the module-level Single Responsibility the project mandates, while reusing the `Video` entity, config and storage client under a single DoD pipeline; a workspace package (B) only pays off once the worker needs an independent release cycle.

**Decision:** A (Modular monolith, two entrypoints)

---

## TD-11: FFmpeg / ffprobe Integration

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The worker must extract duration and metadata (ffprobe) and extract a frame (ffmpeg). The decision covers how Node invokes the binaries and where the binaries come from. Depends on TD-10.

**Options:**

### Option A: System `ffmpeg` package in the worker image + thin `execFile` wrapper
- `apt install ffmpeg` in the worker image; a small typed service calls `ffprobe -v error -print_format json -show_format -show_streams <input>` and `ffmpeg ...` via `child_process.execFile`/`spawn` (args array, no shell), parsing JSON output into a typed result.
- **Pros:** No extra npm dependency; full control and typing of the two commands actually used; args array avoids shell injection; Debian's ffmpeg build supports HTTP input (TD-12).
- **Cons:** Small wrapper to write and test (timeouts, stderr capture, exit codes).

### Option B: `fluent-ffmpeg` wrapper + system binary
- Fluent builder API around the binaries.
- **Pros:** Familiar API, many examples, still widely downloaded; types available via `@types/fluent-ffmpeg`.
- **Cons:** **Abandoned upstream:** deprecated on npm ("Package no longer supported") and GitHub repository `fluent-ffmpeg/node-fluent-ffmpeg` archived (both on 2025-05-22), last release 2.1.3 on 2024-05-19, 419 issues frozen open — no fixes for future FFmpeg CLI/output changes or vulnerabilities. Callback/event-emitter API needs promise wrapping anyway, and types live in a separate community package that can drift. For the two commands this phase needs, it adds an unmaintained dependency without removing meaningful code.

### Option C: Bundled binaries via npm (`ffmpeg-static` / `@ffprobe-installer`) + `execFile`
- Binaries downloaded at `npm install`.
- **Pros:** Same version across host and container; no apt step.
- **Cons:** Large download into `node_modules` of a bind-mounted project shared by API and worker; static builds' protocol/codec support varies; architecture-specific binaries complicate the dev image.

**Recommendation:** **Option A** — only two commands are needed (ffprobe JSON probe and single-frame extraction), so a typed `execFile` wrapper over the distro binary is less surface than adopting the now-deprecated `fluent-ffmpeg` and avoids shipping static binaries through the bind-mounted `node_modules`.

**Decision:** A (Distro ffmpeg + typed execFile wrapper)
**Libraries:** —

**Revisions:**
- 2026-10-30 — Persisted metadata defined: the ffprobe result maps to `Video` columns `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nullable — videos without audio), `container_format`, `bitrate`, `size_bytes`. Rationale: resolves phase-03-videos validation AMB-1 ("extração de duração e metadados" did not name the fields).

---

## TD-12: Worker Media Input Access

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The source object can be 10GB. How ffprobe/ffmpeg read it defines worker disk requirements and processing time. Depends on TD-03, TD-04, TD-11.

**Options:**

### Option A: Pass a short-lived presigned GET URL (internal endpoint) directly to ffprobe/ffmpeg
- Worker signs a GET URL against `S3_ENDPOINT` and passes it as the input; FFmpeg issues HTTP Range requests, reading only headers/index and the frames it needs.
- **Pros:** No local copy of 10GB; probing and seeking to a frame touch a small fraction of the file. No worker volume sizing.
- **Cons:** Depends on FFmpeg's HTTP seeking (works with Range-capable servers — RustFS and S3 document range reads; covered by the TD-02 gate); slower if the MP4 index (`moov`) is at the end (an extra range read, still not a full download).

### Option B: Download the object to a temporary volume, then process locally
- `GetObject` stream → temp file → ffprobe/ffmpeg → delete.
- **Pros:** Deterministic local I/O; works with any container format quirk.
- **Cons:** Transfers the full 10GB per job; needs ≥10GB free disk per concurrent job; much slower end-to-end; cleanup on crash.

### Option C: Stream the object to FFmpeg's stdin
- Pipe `GetObject` body into `ffmpeg -i pipe:0`.
- **Pros:** No temp disk.
- **Cons:** Pipes are not seekable — MP4/MOV with `moov` at the end cannot be probed or seeked correctly; still transfers the whole file.

**Recommendation:** **Option A (presigned URL as FFmpeg input)** — probing and single-frame extraction need only small ranges of the file, so letting FFmpeg range-read over HTTP avoids moving 10GB per job and avoids sizing worker disks.

**Decision:** A (Presigned URL as FFmpeg input)

---

## TD-13: Thumbnail Frame Selection Policy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** "A frame" must be chosen deterministically and cheaply. The first frame is often black (fade-in). The policy also fixes the output format/size stored under the TD-04 key. Depends on TD-11, TD-12.

**Options:**

### Option A: Seek to a fraction of the duration and grab one frame
- `ffmpeg -ss <min(10% of duration, N s)> -i <input> -frames:v 1 -vf scale=...` → JPEG.
- **Pros:** One seek + one decode — cheap even for long videos over HTTP (TD-12); deterministic and easy to test.
- **Cons:** Can land on an uninteresting frame.

### Option B: Seek, then FFmpeg's `thumbnail` filter over a short window
- Seek as in A, then `-vf thumbnail=<n>` picks the most representative frame among the next *n* frames.
- **Pros:** Better-looking thumbnails (avoids transition/black frames).
- **Cons:** Decodes *n* frames (more CPU/range reads); output harder to assert in tests.

### Option C: First frame (`-ss 0`)
- **Pros:** Trivial.
- **Cons:** Frequently black/blank; poor result.

**Recommendation:** **Option A** — a single seek-and-grab at ~10% of the duration (bounded, falling back to 0 for very short clips) is the cheapest deterministic choice over range-read input, and Phase 04 already lets owners upload a custom thumbnail when the automatic one is poor; proposed output: JPEG, 1280px wide, aspect preserved.

**Decision:** A (Single frame at ~10% of duration)

---

## TD-14: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short unique id that "never conflicts" (§4). It becomes the public URL segment (API routes now, frontend routes like `/watch/{id}` later) and a unique DB column — a contract between both layers. The entity PK convention is UUID (`channels`, `users`).

**Options:**

### Option A: Random 11-char base64url id from `crypto.randomBytes(8)` + unique index
- Generate 64 random bits, encode base64url (11 chars, YouTube-like), store in `public_id` with a unique constraint; on the (astronomically rare) unique violation, regenerate and retry.
- **Pros:** Short, non-enumerable, no new dependency (Node `crypto`). Uniqueness *guaranteed* by the DB constraint, not by probability alone. Decoupled from the internal UUID PK.
- **Cons:** Retry-on-conflict logic to write and test.

### Option B: Use the UUID primary key in URLs
- **Pros:** Zero extra column or logic; already unique.
- **Cons:** 36-char URLs, not "curta" (§4 asks for a short URL); exposes the internal PK.

### Option C: Encode a sequential number (Sqids/Hashids)
- Encode a serial/bigint column into a short string.
- **Pros:** Short, collision-free by construction.
- **Cons:** Reversible/enumerable by design (sequential ids leak volume and allow scraping of unlisted videos — a Phase 04 visibility); adds a dependency and a sequence column.

### Option D: `nanoid` (custom length)
- **Pros:** Well-known, configurable alphabet/length.
- **Cons:** Current major is ESM-only in a CommonJS (`nodenext`) project; offers nothing over Option A for a fixed 11-char base64url id.

**Recommendation:** **Option A** — 64 random bits in 11 base64url characters give a short, non-guessable id (important once Phase 04 adds unlisted videos) with no new dependency, and the unique index plus regenerate-on-violation turns "probably unique" into "guaranteed unique".

**Decision:** A (11-char base64url from randomBytes + unique index)

---

## TD-15: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file (HTTP Range / `206 Partial Content`), and users must be able to download the original. The diagram routes `Frontend → Object Storage: Streams`. The choice defines the API endpoints/responses and how the client player obtains its `src`. Depends on TD-03, TD-04, TD-16.

**Options:**

### Option A: API authorizes, then returns/redirects to a short-lived presigned GET URL
- `GET /videos/:publicId/stream` → `302` to a presigned GET URL (public endpoint); storage serves Range requests with `206` natively. `GET /videos/:publicId/download` → `302` to a presigned URL with `ResponseContentDisposition: attachment; filename="..."`.
- **Pros:** Bytes never pass through Nest; Range/206, seeking and concurrency handled by RustFS/S3 (and later a CDN). Download is the same mechanism with one extra signed parameter. Matches the diagram.
- **Cons:** The URL is a bearer token until it expires (short TTL mitigates). Players re-request the API when the URL expires during very long sessions.

### Option B: API proxies the bytes with Range support
- API parses `Range`, calls `GetObject` with the same range, pipes the body with `206` + `Content-Range`.
- **Pros:** Storage stays fully private; per-request authorization on every chunk.
- **Cons:** Every viewer's bytes flow through the API — the system-load problem the upload design avoided now appears on playback; Range parsing/edge cases to implement and test.

### Option C: Adaptive streaming (HLS/DASH transcoding)
- Worker transcodes into segmented renditions + manifest; player uses HLS.
- **Pros:** Adaptive bitrate, best playback experience at scale.
- **Cons:** Heavy CPU/storage cost and long processing for 10GB inputs; not required by any Phase 03 capability (progressive streaming satisfies "sem download completo"); much larger scope.

**Recommendation:** **Option A (authorize-then-redirect to presigned URL)** — object storage already implements Range/`206` correctly, so redirecting to a short-lived signed URL delivers streaming and attachment downloads without putting video bytes on the API, consistent with both the upload design and the architecture diagram.

**Decision:** A (Authorize, then redirect to presigned GET)
**Libraries:** —

**Revisions:**
- 2026-10-30 — `302` contract kept; Phase 03 is backend-only (no FE consumer of stream/download). Constraint recorded for the phase that adds the player UI: under the inherited strict-BFF model (phase-02-auth-frontend/TD-01, TD-05) the BFF Route Handler must call these endpoints with `fetch(..., { redirect: 'manual' })` and forward the `Location` header to the browser — never follow the redirect server-side (it would stream the video through the BFF). Alternative open to that phase: revise this TD to return `{ url, expiresAt }` as JSON. Rationale: resolves phase-03-videos validation ICC-1.

---

## TD-16: Playback/Download Access Policy in Phase 03

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Every Phase 03 video is a draft (TD-08); publication and public/unlisted visibility arrive in Phase 04. The plan states anonymous users can watch freely — but that refers to published videos. Phase 03 must still decide who may stream/download, because it defines the Authorization Matrix and which endpoints are `@Public()` under the global JWT guard. Depends on TD-08.

**Options:**

### Option A: Owner-only while draft (authenticated channel owner)
- Stream/download require a valid JWT whose user owns the video's channel and `processing_status = ready`; others get `404` (not revealing existence). Phase 04 relaxes this for published public/unlisted videos.
- **Pros:** Consistent with "draft = not published"; no anonymous access to unpublished content; Phase 04 adds rules instead of removing a hole.
- **Cons:** Anonymous playback cannot be demonstrated until Phase 04.

### Option B: Anyone with the `publicId` (anonymous) once `ready`
- Endpoints are `@Public()`; possession of the unguessable id (TD-14) grants access.
- **Pros:** Exercises the anonymous-viewing path early.
- **Cons:** Exposes unpublished drafts publicly; Phase 04 must tighten access (a breaking change in behavior) and any link shared during Phase 03 would leak drafts.

**Recommendation:** **Option A (owner-only while draft)** — all Phase 03 videos are unpublished drafts, so restricting stream/download to the owning channel matches the draft semantics and lets Phase 04 open access for published videos additively.

**Decision:** A (Owner-only while draft)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message queue technology | **A** (BullMQ + Redis via `@nestjs/bullmq`) | **A (BullMQ + Redis)** |
| TD-02 | Repo-wide | Local S3-compatible storage container | **A** (last upstream `minio/minio`, pinned) | **C (RustFS)** |
| TD-03 | Backend | S3 client library | **A** (AWS SDK v3 + s3-request-presigner) | **A (AWS SDK v3)** |
| TD-04 | Backend | Bucket layout, key scheme, storage endpoint contract | **A** (single private bucket, `videos/{id}/…`, internal + public endpoints) | **A (Single private bucket, per-video prefixes, internal/public endpoints)** |
| TD-05 | Cross-layer | 10GB upload protocol | **A** (presigned S3 multipart, direct to storage) | **A (Presigned S3 multipart, direct to storage)** |
| TD-06 | Cross-layer | Upload limits and validation policy | **B** (declared + `HeadObject` on complete + ffprobe; 10 GiB / 64 MiB parts / 1h TTL) | **B (Declared metadata + HeadObject on complete + ffprobe)** |
| TD-07 | Cross-layer | Upload completion → processing trigger | **A** (client calls complete endpoint; API enqueues with `jobId = videoId`) | **A (Explicit complete endpoint)** |
| TD-08 | Backend | Video status model and draft pre-registration | **B** (`processing_status` + `publication_status`) | **B (processing_status + publication_status)** |
| TD-09 | Backend | Processing failure and retry policy | **A** (3 attempts + backoff, unrecoverable media errors, terminal `failed`) | **A (Bounded retries + unrecoverable media errors + terminal failed)** |
| TD-10 | Repo-wide | Video worker runtime topology | **A** (modular monolith: `videos` / `storage` / `video-processing` modules, `main.ts` + `worker.ts`) | **A (Modular monolith, two entrypoints)** |
| TD-11 | Backend | FFmpeg / ffprobe integration | **A** (distro ffmpeg + typed `execFile` wrapper) | **A (Distro ffmpeg + typed execFile wrapper)** |
| TD-12 | Backend | Worker media input access | **A** (presigned URL as FFmpeg input, range reads) | **A (Presigned URL as FFmpeg input)** |
| TD-13 | Backend | Thumbnail frame selection policy | **A** (single frame at ~10% of duration, JPEG) | **A (Single frame at ~10% of duration)** |
| TD-14 | Cross-layer | Unique video URL identifier | **A** (11-char base64url from `randomBytes(8)` + unique index) | **A (11-char base64url from randomBytes + unique index)** |
| TD-15 | Cross-layer | Streaming and download delivery | **A** (authorize → 302 to presigned GET; attachment disposition for download) | **A (Authorize, then redirect to presigned GET)** |
| TD-16 | Backend | Playback/download access policy in Phase 03 | **A** (owner-only while draft) | **A (Owner-only while draft)** |
