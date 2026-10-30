// Errors raised by the media tools. They carry no queue semantics: the
// processor decides which ones are terminal (TD-09).

/** The input was read but is not a usable video (no video stream, bad data). */
export class InvalidMediaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidMediaError';
  }
}

/** The tool could not do its job for a transient reason (network, timeout). */
export class MediaToolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MediaToolError';
  }
}
