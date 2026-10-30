export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

export const STORAGE_BUCKET_CORS = {
  ALLOWED_METHODS: ['PUT', 'GET', 'HEAD'],
  ALLOWED_HEADERS: ['*'],
  EXPOSE_HEADERS: ['ETag'],
} as const;

export const STORAGE_BUCKET_LIFECYCLE = {
  ABORT_INCOMPLETE_MULTIPART_RULE_ID: 'abort-incomplete-multipart-uploads',
  ABORT_INCOMPLETE_MULTIPART_DAYS: 2,
} as const;

export const S3_ERROR_NAMES = {
  NO_SUCH_UPLOAD: 'NoSuchUpload',
  INVALID_PART: 'InvalidPart',
  INVALID_PART_ORDER: 'InvalidPartOrder',
  ENTITY_TOO_SMALL: 'EntityTooSmall',
  NOT_FOUND: 'NotFound',
  NO_SUCH_KEY: 'NoSuchKey',
  NO_SUCH_BUCKET: 'NoSuchBucket',
  BUCKET_ALREADY_OWNED_BY_YOU: 'BucketAlreadyOwnedByYou',
} as const;
