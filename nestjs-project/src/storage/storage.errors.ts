// Storage-level errors. They carry no HTTP semantics: callers (e.g. the videos
// module) map them to their own domain exceptions.
export abstract class StorageError extends Error {
  constructor(
    message: string,
    public readonly key: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** The multipart upload id does not exist (aborted, completed or expired). */
export class MultipartUploadNotFoundError extends StorageError {
  constructor(key: string, uploadId: string, options?: { cause?: unknown }) {
    super(
      `Multipart upload ${uploadId} not found for key ${key}`,
      key,
      options,
    );
  }
}

/** The part list sent on completion was rejected by the storage. */
export class InvalidUploadPartsError extends StorageError {
  constructor(
    key: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Invalid upload parts for key ${key}: ${reason}`, key, options);
  }
}

/** The object does not exist in the bucket. */
export class StorageObjectNotFoundError extends StorageError {
  constructor(key: string, options?: { cause?: unknown }) {
    super(`Object not found for key ${key}`, key, options);
  }
}
