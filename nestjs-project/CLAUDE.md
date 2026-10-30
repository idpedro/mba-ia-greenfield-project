# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **RustFS:** `docker compose exec nestjs-api curl -s http://rustfs:9000/health` — expect `"status":"ok"`
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`, data in the named volume `postgres_data`
- `mailpit` — SMTP `1025`, web UI `http://localhost:8025`
- `redis` — Redis 7.4 (BullMQ queues), internal only (`redis:6379`)
- `rustfs` — S3-compatible object storage (videos and thumbnails). Containers use `S3_ENDPOINT=http://rustfs:9000`; the browser uses `S3_PUBLIC_ENDPOINT`. The host port is `${S3_HOST_PORT:-9000}` — if 9000 is taken, set `S3_HOST_PORT` in `.env` and point `S3_PUBLIC_ENDPOINT` to the same port (e.g. `S3_HOST_PORT=9004`, `S3_PUBLIC_ENDPOINT=http://localhost:9004`). Tests force `S3_PUBLIC_ENDPOINT=http://rustfs:9000` (`src/test/setup-test-env.ts`)
- `video-worker` — second Nest process (`npm run start:worker:dev`, entrypoint `src/worker.ts`): consumes the BullMQ jobs and runs FFmpeg, no HTTP. It starts automatically with `docker compose up -d`; `docker compose stop` waits up to 3 min (`stop_grace_period`) for an active job. It shares `dist/` with the API, so starting `start:dev` in `nestjs-api` rebuilds `dist/` and makes the worker restart

Host-side ports are configurable in `.env` (`API_HOST_PORT`, `DB_HOST_PORT`, `MAIL_SMTP_HOST_PORT`, `MAIL_UI_HOST_PORT`; defaults are the ports above) for machines where a default port is already taken. Containers always reach each other on the internal ports (`db:5432`, `mailpit:1025`).

The full upload → processing → streaming flow is scripted in `api.http` (requests 10–17).

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify Redis and RustFS are ready
docker compose exec redis redis-cli ping
docker compose exec nestjs-api curl -s http://rustfs:9000/health

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs -f video-worker   # follow video processing jobs

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run openapi:export                   # Regenerate the versioned openapi.json (exits, no server)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
docker compose exec nestjs-api curl -s http://rustfs:9000/health
docker compose logs -f video-worker
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["<setup-test-env>", "dotenv/config"]` — `dotenv/config` loads `.env` inside the Jest process; without it `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS. `src/test/setup-test-env.ts` runs **first** and sets `S3_PUBLIC_ENDPOINT=http://rustfs:9000` (dotenv never overrides an existing variable): presigned URLs sign the host (SigV4), so tests must get URLs the container can reach and must never rewrite their host. Path is `<rootDir>/test/setup-test-env.ts` in `package.json` (rootDir `src`) and `<rootDir>/../src/test/setup-test-env.ts` in `test/jest-e2e.json` (rootDir `test`).
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos (upload, processing, streaming)

Bytes never pass through the API: the browser uploads parts straight to object storage with presigned multipart URLs, and playback/download are `302` redirects to presigned GETs.

**Modules** (import other modules only through their `index.ts` — ESLint `no-restricted-imports` forbids deep imports into `src/storage/*` and `src/video-processing/*`):

- `src/videos/` — `VideosModule` (API only): `VideosController`, `VideoUploadService` (initiate / sign part URLs / list parts / complete + enqueue), `VideosService` (owner-scoped lookups), `VideoDeliveryService` (stream/download URLs), `VideoPresenter`, entity `entities/video.entity.ts`, `upload-limits.ts`, `video.exceptions.ts`
- `src/storage/` — `StorageModule`: two `S3Client`s (`S3_INTERNAL_CLIENT` → `S3_ENDPOINT` for server-side calls, `S3_PUBLIC_CLIENT` → `S3_PUBLIC_ENDPOINT` for URLs handed to clients), `StorageService`, `StorageBootstrapService` (creates the bucket, CORS and the 2-day `AbortIncompleteMultipartUpload` lifecycle rule on boot). Both clients use `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'` — RustFS rejects SDK-default checksums on presigned part PUTs
- `src/video-processing/` — `VideoProcessingModule` (worker only): `VideoProcessingProcessor` (`process-video`), `StaleUploadSweepProcessor` + `StaleUploadSweepScheduler` (`expire-stale-uploads`), `ffmpeg/FfmpegService` (`execFile` wrappers for ffprobe/ffmpeg); queue/job names in `video-processing.constants.ts`
- `src/queue/` (`QueueModule`, BullMQ root connection), `src/database/` (`DatabaseModule`, shared by API and worker)
- `src/worker.ts` + `src/worker.module.ts` — worker entrypoint (`npm run start:worker:dev`), no HTTP; the API (`AppModule`) only produces jobs

**Endpoints** (all require auth and are owner-only; another channel's video returns `404 VIDEO_NOT_FOUND`):

| Route | Purpose |
|---|---|
| `POST /videos` | Creates the draft (`pending_upload`), opens the multipart upload, returns the upload plan (64 MiB parts) |
| `POST /videos/:id/upload/part-urls` | Presigned `UploadPart` URLs (1h) for up to 100 part numbers |
| `GET /videos/:id/upload/parts` | Parts already uploaded (resume) |
| `POST /videos/:id/upload/complete` | Completes the upload, checks the size, sets `processing`, enqueues `process-video` (`jobId = videoId`) |
| `GET /videos/:slug` | Detail + status + metadata + presigned `thumbnail_url` |
| `GET /videos/:slug/stream` | `302` to a presigned GET (Range/206 handled by storage), `Cache-Control: no-store` |
| `GET /videos/:slug/download` | Same, with `Content-Disposition: attachment` (RFC 5987 filename) |

Limits: 10 GiB max, MIME `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`. Slug: 11-char base64url, unique. The full flow is scripted in `api.http` (requests 10–17).

**Status lifecycle** (`processing_status`; `publication_status` is always `draft` in this phase): `pending_upload` → `processing` (complete) → `ready` (worker persisted duration, dimensions, codecs, container, bitrate and the thumbnail) or `failed` with `failure_reason`: `size_mismatch` (complete), `invalid_media` (ffprobe rejects the file, no retry), `processing_error` (3 attempts exhausted), `upload_expired` (hourly sweep: `pending_upload` older than 24h, multipart aborted).

**Storage keys** (single private bucket `S3_BUCKET`): `videos/{id}/original`, `videos/{id}/thumbnail.jpg` (JPEG, 1280px wide, frame at 10% of the duration).

**Testing:** storage/queue/ffmpeg tests run against the real `rustfs`, `redis` and ffmpeg. Integration tests use a throwaway bucket (`src/test/storage.ts`) and media generated by ffmpeg (`src/test/video-fixture.ts`); anything that creates BullMQ queues or workers uses its own `prefix` (`test-<uuid>`) so the running `video-worker` never consumes test jobs.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
