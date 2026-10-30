import { randomBytes } from 'node:crypto';

const VIDEO_SLUG_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Public, unguessable video identifier: 8 random bytes encoded as
 * base64url (11 chars in `[A-Za-z0-9_-]`, no padding).
 */
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}

/** Whether `value` has the shape produced by `generateVideoSlug`. */
export function isVideoSlug(value: string): boolean {
  return VIDEO_SLUG_PATTERN.test(value);
}
