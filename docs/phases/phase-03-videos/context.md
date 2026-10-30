---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-05-07T21:03:39-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-30T03:20:54-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-22T11:01:47-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-22T11:01:47-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-22T11:01:47-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-22T11:01:47-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-30T03:21:57-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-05-07T21:03:39-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única.

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None named explicitly in the phase body. It doesn't mention `nestjs-project`, `nextjs-project` or any other subproject path._

**Deferred subprojects:** _None._

**Sequencing notes:** > Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta. "Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha."
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03). "Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública."

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | bullmq@^6.5.1, @nestjs/bullmq@^11.0.5 |
| phase-03-videos/TD-02 | phase | Repo-wide | Local S3-Compatible Storage Container | decided | C (RustFS) | — |
|     └─ Last revision: 2026-10-30 — Storage compatibility gate extended with one more check: `PutBucketLifecycleCo… | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | S3 Client Library | decided | A (AWS SDK v3) | @aws-sdk/client-s3@^3.1160.0, @aws-sdk/s3-request-presigner@^3.1160.0 |
| phase-03-videos/TD-04 | phase | Backend | Bucket Layout, Object Key Scheme and Storage Endpoint Contract | decided | A (Single private bucket, per-video prefixes, internal/public endpoints) | — |
| phase-03-videos/TD-05 | phase | Cross-layer | 10GB Upload Protocol (Direct-to-Storage) | decided | A (Presigned S3 multipart, direct to storage) | — |
| phase-03-videos/TD-06 | phase | Cross-layer | Upload Limits and Validation Policy | decided | B (Declared metadata + HeadObject on complete + ffprobe) | — |
|     └─ Last revision: 2026-10-30 — Proposed limits confirmed: max size **10 GiB**, server-defined part size **64 MiB**, p… | | | | | | |
| phase-03-videos/TD-07 | phase | Cross-layer | Upload Completion → Processing Trigger | decided | A (Explicit complete endpoint) | — |
| phase-03-videos/TD-08 | phase | Backend | Video Status Model and Draft Pre-Registration | decided | B (processing_status + publication_status) | — |
|     └─ Last revision: 2026-10-30 — Stale-upload rule decided: an hourly BullMQ repeatable job marks videos still in `pe… | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Processing Failure and Retry Policy | decided | A (Bounded retries + unrecoverable media errors + terminal failed) | — |
| phase-03-videos/TD-10 | phase | Repo-wide | Video Worker Runtime Topology | decided | A (Modular monolith, two entrypoints) | — |
| phase-03-videos/TD-11 | phase | Backend | FFmpeg / ffprobe Integration | decided | A (Distro ffmpeg + typed execFile wrapper) | — |
|     └─ Last revision: 2026-10-30 — Persisted metadata defined: the ffprobe result maps to `Video` columns `duration_se… | | | | | | |
| phase-03-videos/TD-12 | phase | Backend | Worker Media Input Access | decided | A (Presigned URL as FFmpeg input) | — |
| phase-03-videos/TD-13 | phase | Backend | Thumbnail Frame Selection Policy | decided | A (Single frame at ~10% of duration) | — |
| phase-03-videos/TD-14 | phase | Cross-layer | Unique Video URL Identifier | decided | A (11-char base64url from randomBytes + unique index) | — |
| phase-03-videos/TD-15 | phase | Cross-layer | Streaming and Download Delivery | decided | A (Authorize, then redirect to presigned GET) | — |
|     └─ Last revision: 2026-10-30 — `302` contract kept; Phase 03 is backend-only (no FE consumer of stream/download). C… | | | | | | |
| phase-03-videos/TD-16 | phase | Backend | Playback/Download Access Policy in Phase 03 | decided | A (Owner-only while draft) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-10 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-05, phase-03-videos/TD-06 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-07, phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-10, phase-03-videos/TD-13 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-14 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-15, phase-03-videos/TD-16 |
| Download do vídeo pelo usuário | phase-03-videos/TD-15, phase-03-videos/TD-16 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the only option with an official Nest 11 integration *and* job semantics (retry/backoff, stalled-job recovery, unrecoverable errors, idempotent `jobId`) out of the box, which is exactly what long FFmpeg jobs need; the cost is one Redis container, and the dual-write gap is closed cheaply with `jobId = videoId` plus the status rules of TD-07/TD-09. pg-boss is a legitimate alternative if avoiding new infra outweighs the missing Nest integration.
**Libraries:** bullmq@^6.5.1, @nestjs/bullmq@^11.0.5

### phase-03-videos/TD-02

**Recommendation:** the container only backs local dev and the integration/e2e suites, while production targets AWS S3, so a frozen-but-pinned image costs no production risk and keeps the project aligned with the diagram and the challenge; Option B is the drop-in fallback if a patched image becomes necessary.

**Note:** Decision deliberately diverges from the Recommendation — the user prefers a maintained, permissively licensed server over a frozen MinIO image; the S3 API contract (TD-03..TD-07, TD-12, TD-15) is unchanged, only the local container differs. Because RustFS's docs do not explicitly cover every operation this phase depends on, the plan must include an early **storage compatibility gate** (integration tests against the real `rustfs` Compose service, run before any upload/streaming SI builds on it) covering: presigned `UploadPart` PUT from a non-SDK HTTP client, `ListParts` after a partial upload, `CompleteMultipartUpload` + `HeadObject` size, Range GET → `206`, presigned GET with `ResponseContentDisposition`, CORS preflight exposing `ETag`, and ffprobe/ffmpeg reading a presigned URL. Fallback if any check fails: Option A (pinned MinIO), with no application-code change. Exact image name/tag is pinned in `/plan-resolve`.

**Libraries:** —

**Revisions:**
- 2026-10-30 — Local storage image pinned to `rustfs/rustfs:1.0.4` (latest stable tag on Docker Hub as of 2026-10-30; `-glibc` variant not used). Rationale: resolves the pending image pin (phase-03-videos validation OQ-1); an exact tag keeps the storage compatibility gate reproducible.
- 2026-10-30 — Storage compatibility gate extended with one more check: `PutBucketLifecycleConfiguration` with an `AbortIncompleteMultipartUpload` rule is accepted by RustFS and read back via `GetBucketLifecycleConfiguration`. Rationale: resolves phase-03-videos validation IC-2 — TD-08's stale-upload backstop depends on this bucket feature, which RustFS's docs do not explicitly cover; failing it triggers the same fallback (pinned MinIO, no application-code change).

### phase-03-videos/TD-03

**Recommendation:** production storage is S3, so using AWS's own SDK keeps dev and prod on one code path, and it exposes every multipart/presign command TD-05 and TD-15 need as typed commands.
**Libraries:** @aws-sdk/client-s3@^3.1160.0, @aws-sdk/s3-request-presigner@^3.1160.0

### phase-03-videos/TD-04

**Recommendation:** one private bucket with per-video prefixes keeps cleanup and bootstrap trivial for a phase that has a single owner of both assets, and the explicit `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` split is mandatory for any presigned-URL design inside Docker; Option B only pays off once thumbnails need a different visibility, which is a Phase 04+ concern.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** it is the only option that keeps every file byte off the API, supports 10GB (multipart allows up to 10,000 parts) and resumes per part, using a native S3 feature available on both RustFS (subject to the TD-02 gate) and AWS S3.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** the completion `HeadObject` check plus ffprobe validation enforce size and type without routing bytes through the API; proposed values for `/plan-resolve` to confirm: max **10 GiB**, server-defined part size **64 MiB**, presigned URL TTL **1h** (re-signable on resume), accepted MIME `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`.
**Libraries:** —

**Revisions:**
- 2026-10-30 — Proposed limits confirmed: max size **10 GiB**, server-defined part size **64 MiB**, presigned part URL TTL **1h** (re-signable on resume), accepted MIME `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`. Rationale: resolves phase-03-videos validation OQ-2; values flow into DTO validation, the env/config schema and the client chunking loop.

### phase-03-videos/TD-07

**Recommendation:** S3 multipart completion already requires the client's ETag list, so a single complete endpoint that finalizes, verifies and enqueues is the simplest flow that works the same on RustFS and S3 and gives the client immediate errors.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** the project plan explicitly has a draft→publish flow in Phase 04 that is independent of processing outcome, so separating `processing_status` from `publication_status` now avoids an enum rework later; the stale-upload rule (videos stuck in `pending_upload` beyond the URL TTL window are marked failed and their multipart upload aborted) should be resolved in `/plan-resolve`.
**Libraries:** —

**Revisions:**
- 2026-10-30 — Stale-upload rule decided: an hourly BullMQ repeatable job marks videos still in `pending_upload` 24h after creation as `failed` with `failure_reason = upload_expired` and calls `AbortMultipartUpload` for their open upload; the bucket also gets an `AbortIncompleteMultipartUpload` lifecycle rule (2 days) as a backstop. Rationale: resolves phase-03-videos validation OQ-3; the 24h window comfortably exceeds the 1h re-signable URL TTL (TD-06) so resumed uploads are not killed.

### phase-03-videos/TD-09

**Recommendation:** bounded retries with backoff cover transient storage/worker failures while unrecoverable media errors fail fast, and the terminal `failed` + reason satisfies the "pronto/erro reflected in the DB" criterion without adding an out-of-scope reprocess feature.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** a modular monolith with bounded `videos` / `storage` / `video-processing` modules and two entrypoints gives the process isolation the diagram requires and the module-level Single Responsibility the project mandates, while reusing the `Video` entity, config and storage client under a single DoD pipeline; a workspace package (B) only pays off once the worker needs an independent release cycle.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** only two commands are needed (ffprobe JSON probe and single-frame extraction), so a typed `execFile` wrapper over the distro binary is less surface than adopting the now-deprecated `fluent-ffmpeg` and avoids shipping static binaries through the bind-mounted `node_modules`.
**Libraries:** —

**Revisions:**
- 2026-10-30 — Persisted metadata defined: the ffprobe result maps to `Video` columns `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nullable — videos without audio), `container_format`, `bitrate`, `size_bytes`. Rationale: resolves phase-03-videos validation AMB-1 ("extração de duração e metadados" did not name the fields).

### phase-03-videos/TD-12

**Recommendation:** probing and single-frame extraction need only small ranges of the file, so letting FFmpeg range-read over HTTP avoids moving 10GB per job and avoids sizing worker disks.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** a single seek-and-grab at ~10% of the duration (bounded, falling back to 0 for very short clips) is the cheapest deterministic choice over range-read input, and Phase 04 already lets owners upload a custom thumbnail when the automatic one is poor; proposed output: JPEG, 1280px wide, aspect preserved.
**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** 64 random bits in 11 base64url characters give a short, non-guessable id (important once Phase 04 adds unlisted videos) with no new dependency, and the unique index plus regenerate-on-violation turns "probably unique" into "guaranteed unique".
**Libraries:** —

### phase-03-videos/TD-15

**Recommendation:** object storage already implements Range/`206` correctly, so redirecting to a short-lived signed URL delivers streaming and attachment downloads without putting video bytes on the API, consistent with both the upload design and the architecture diagram.
**Libraries:** —

**Revisions:**
- 2026-10-30 — `302` contract kept; Phase 03 is backend-only (no FE consumer of stream/download). Constraint recorded for the phase that adds the player UI: under the inherited strict-BFF model (phase-02-auth-frontend/TD-01, TD-05) the BFF Route Handler must call these endpoints with `fetch(..., { redirect: 'manual' })` and forward the `Location` header to the browser — never follow the redirect server-side (it would stream the video through the BFF). Alternative open to that phase: revise this TD to return `{ url, expiresAt }` as JSON. Rationale: resolves phase-03-videos validation ICC-1.

### phase-03-videos/TD-16

**Recommendation:** all Phase 03 videos are unpublished drafts, so restricting stream/download to the owning channel matches the draft semantics and lets Phase 04 open access for published videos additively.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnkno... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain functi... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-s... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning optio... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
