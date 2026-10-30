import { DomainException } from '../common/exceptions/domain.exception';

// Codes, statuses and messages follow the phase-03 Error Catalog.

/** The video does not exist or belongs to another channel (drafts stay hidden). */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoUploadNotPendingException extends DomainException {
  constructor() {
    super('VIDEO_UPLOAD_NOT_PENDING', 409, 'Video upload is not pending');
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super('INVALID_PART_NUMBER', 400, 'Part number is out of range');
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super('UPLOAD_INCOMPLETE', 400, 'Uploaded parts are incomplete or invalid');
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      422,
      'Uploaded file size does not match the declared size',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}
