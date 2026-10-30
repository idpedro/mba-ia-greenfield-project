// Single source for the upload limits: DTO decorators and services import
// these values instead of repeating them as literals.

/** Largest accepted video: 10 GiB. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

/** Server-defined multipart part size: 64 MiB. */
export const UPLOAD_PART_SIZE_BYTES = 64 * 1024 ** 2;

/** Lifetime of every presigned URL handed to the client: 1 hour. */
export const PRESIGNED_URL_TTL_SECONDS = 3600;

export const ACCEPTED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export type AcceptedVideoMimeType = (typeof ACCEPTED_VIDEO_MIME_TYPES)[number];

/** Number of parts the client must send for a file of `sizeBytes`. */
export function calculatePartCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES);
}

/** Most part URLs a single `part-urls` request may ask for. */
export const MAX_PART_URLS_PER_REQUEST = 100;

/** Most parts a multipart upload may have (S3 limit). */
export const MAX_UPLOAD_PARTS = 10000;
