---
libs:
  "bullmq":
    version: "^6.5.1"
    context7_id: "/taskforcesh/bullmq/v6.3.11"
    fetched_at: "2026-10-30T03:20:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-30T03:20:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1160.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-30T03:20:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1160.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-30T03:20:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-30T03:20:54-03:00"
---

# Library References — phase-03-videos

### bullmq

_Used by phase-03-videos/TD-01 (queue), TD-07 (enqueue on complete), TD-08 (stale-upload scheduler), TD-09 (retry policy)._

- **Version note:** Context7 latest indexed doc set is `v6.3.11`; installed target is `^6.5.1` (same major — APIs below are v6).
- **Idempotent enqueue (TD-07 `jobId = videoId`):** `queue.add(name, data, { jobId })`. If a job with that id already exists in the queue, the add is ignored. Custom ids must not contain `:` and must not be purely numeric strings — a UUID video id is fine.
- **Retry policy (TD-09):** `queue.add(name, data, { attempts: N, backoff: { type: 'exponential', delay: ms } })` (number shorthand `backoff: 1000` = fixed delay).
- **Fail fast on bad media (TD-09):** throw `new UnrecoverableError(msg)` (import from `bullmq`) inside the processor — moves the job to failed immediately, ignoring `attempts`.
- **Repeatable jobs (TD-08 hourly stale-upload sweep):** v6 uses **Job Schedulers** — `queue.upsertJobScheduler(schedulerId, { every: 3_600_000 } | { pattern: '0 0 * * * *' }, { name, data, opts })`. Upsert is idempotent per `schedulerId` (safe to call on every boot). Legacy `repeat` options on `queue.add` were migrated to this API in v6 — do not use them.

### @nestjs/bullmq

_Used by phase-03-videos/TD-01, TD-10 (API = producer, worker entrypoint = consumer)._

- **Version note:** `^11.0.5` chosen to match the project's Nest 11 major (peer: `@nestjs/common|core ^10 || ^11`, `bullmq ^3..^6`). `12.0.0` also exists and accepts Nest 11, but is a fresh major — not adopted.
- **Root config:** `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg: ConfigType<typeof queueConfig>) => ({ connection: { host: cfg.host, port: cfg.port } }) })` — follows the inherited `registerAs` + `ConfigType` convention; host must be the Compose service name (`redis`).
- **Queue registration / producer:** `BullModule.registerQueue({ name: 'video-processing' })`; inject with `@InjectQueue('video-processing') private readonly queue: Queue`.
- **Consumer:** `@Processor('video-processing') class VideoProcessingProcessor extends WorkerHost { async process(job: Job<Payload>) {...} }`. Throwing → retry per `attempts`/`backoff`; the resolved value becomes the job's return value. `this.worker` is only available from `onApplicationBootstrap` onwards.
- **Topology (TD-10):** register the `@Processor` provider only in the worker entrypoint's module graph, so the API process produces but never consumes.

### @aws-sdk/client-s3

_Used by phase-03-videos/TD-03, TD-04, TD-05, TD-06, TD-08, TD-12, TD-15._

- **Client for RustFS / S3:** `new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })`. TD-04 requires **two** clients/configs: internal (`S3_ENDPOINT`, e.g. `http://rustfs:9000`) for server-side calls, and public (`S3_PUBLIC_ENDPOINT`) used only for presigning URLs the browser will hit.
- **Multipart commands (TD-05/TD-06):** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `ListPartsCommand({ Bucket, Key, UploadId })` for resume; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })` — PartNumber is 1..10,000; `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` (TD-08 stale sweep, TD-06 rejects).
- **Size check on complete (TD-06):** `HeadObjectCommand({ Bucket, Key })` → `ContentLength`.
- **Bucket bootstrap (TD-08 backstop, TD-05 CORS):** `PutBucketLifecycleConfigurationCommand` with a rule `{ Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }`; `PutBucketCorsCommand` with `ExposeHeaders: ['ETag']` and `AllowedMethods: ['PUT','GET','HEAD']` for the browser's direct part uploads. Both must be validated against RustFS in the TD-02 compatibility gate.
- **Gotcha (not from Context7 excerpt — verify during implementation):** recent v3 releases send flexible checksums (CRC32/CRC64NVME) by default; S3-compatible servers and presigned `UploadPart` URLs used by non-SDK clients may reject or mis-sign them. If the compatibility gate fails on checksum headers, set `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` on the client.

### @aws-sdk/s3-request-presigner

_Used by phase-03-videos/TD-05 (part URLs), TD-12 (worker ffprobe/ffmpeg input), TD-15 (stream/download)._

- `getSignedUrl(client, command, { expiresIn })` — `expiresIn` in seconds, default **900**; TD-06 fixes upload part URLs at **3600**.
- **Part URLs:** `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 })`, signed only for part numbers `1..partCount` (TD-06).
- **Stream/download (TD-15):** `getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key }))` for streaming; add `ResponseContentDisposition: 'attachment; filename="..."'` for download. Response-header overrides only work on signed requests (presigned URL satisfies this).
- **Worker input (TD-12):** presign the `GetObjectCommand` with the **internal** client (worker reaches storage over the Compose network), not the public one.
