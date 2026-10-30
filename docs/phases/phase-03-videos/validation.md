---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-30T03:22:40-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-30T03:20:54-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-01 (BullMQ) and TD-03 (AWS SDK v3) decide libraries but Libraries field is —"
    resolved_by: phase-03-videos/TD-01, phase-03-videos/TD-03
  - id: IC-2
    status: resolved
    summary: "TD-08 relies on bucket lifecycle rule absent from TD-02's RustFS compat gate"
    resolved_by: phase-03-videos/TD-02
  - id: AMB-1
    status: resolved
    summary: "Which 'metadados' the processing step extracts and persists is unspecified"
    resolved_by: phase-03-videos/TD-11
  - id: ICC-1
    status: resolved
    summary: "TD-15 302-redirect vs inherited strict-BFF: BFF fetch would follow into storage"
    resolved_by: phase-03-videos/TD-15
  - id: OQ-1
    status: resolved
    summary: "TD-02 — RustFS image name/tag not yet pinned"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-2
    status: resolved
    summary: "TD-06 — upload limits (size, part size, URL TTL, MIME list) still proposals"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-3
    status: resolved
    summary: "TD-08 — stale pending_upload cleanup rule not yet decided"
    resolved_by: phase-03-videos/TD-08
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (No `## UI Inventory` in context.md — UI not in scope for this phase.)

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-01, phase-03-videos/TD-03)_ — TD-01 (BullMQ) and TD-03 (AWS SDK v3) decide libraries but Libraries field is —. Libraries filled: TD-01 `bullmq@^6.5.1, @nestjs/bullmq@^11.0.5`; TD-03 `@aws-sdk/client-s3@^3.1160.0, @aws-sdk/s3-request-presigner@^3.1160.0`. Docs cached in `library-refs.md`.
- **AMB-1** _(resolved_by phase-03-videos/TD-11)_ — Which 'metadados' the processing step extracts and persists is unspecified. Revision on TD-11: persisted metadata = `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nullable), `container_format`, `bitrate`, `size_bytes`.
- **ICC-1** _(resolved_by phase-03-videos/TD-15)_ — TD-15 302-redirect vs inherited strict-BFF: BFF fetch would follow into storage. Revision on TD-15: `302` kept (Phase 03 is backend-only); the phase that adds the player must call via BFF with `redirect: 'manual'` and forward `Location`, or revise TD-15 to return `{ url, expiresAt }`.
- **OQ-1** _(resolved_by phase-03-videos/TD-02)_ — TD-02 — RustFS image name/tag not yet pinned. Revision on TD-02: image pinned to `rustfs/rustfs:1.0.4`.
- **OQ-2** _(resolved_by phase-03-videos/TD-06)_ — TD-06 — upload limits (size, part size, URL TTL, MIME list) still proposals. Revision on TD-06: proposed limits confirmed (10 GiB, 64 MiB parts, 1h URL TTL, mp4/webm/quicktime/x-matroska).
- **OQ-3** _(resolved_by phase-03-videos/TD-08)_ — TD-08 — stale pending_upload cleanup rule not yet decided. Revision on TD-08: hourly BullMQ job fails `pending_upload` videos after 24h (`upload_expired`) + aborts multipart; bucket lifecycle `AbortIncompleteMultipartUpload` 2 days as backstop.
- **IC-2** _(resolved_by phase-03-videos/TD-02)_ — TD-08 relies on bucket lifecycle rule absent from TD-02's RustFS compat gate. Revision on TD-02: storage compatibility gate extended with `PutBucketLifecycleConfiguration` (`AbortIncompleteMultipartUpload`) accepted and read back via `GetBucketLifecycleConfiguration`; same pinned-MinIO fallback on failure.
