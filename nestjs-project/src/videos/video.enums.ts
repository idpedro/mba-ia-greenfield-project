export enum VideoProcessingStatus {
  PENDING_UPLOAD = 'pending_upload',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export enum VideoPublicationStatus {
  DRAFT = 'draft',
}

export enum VideoFailureReason {
  UPLOAD_EXPIRED = 'upload_expired',
  SIZE_MISMATCH = 'size_mismatch',
  INVALID_MEDIA = 'invalid_media',
  PROCESSING_ERROR = 'processing_error',
}
