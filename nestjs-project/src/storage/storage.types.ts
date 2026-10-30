export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface StorageObjectHead {
  contentLength: number;
  contentType?: string;
}

export type StorageClientKind = 'internal' | 'public';

export interface SignGetUrlOptions {
  expiresIn: number;
  client: StorageClientKind;
  contentDisposition?: string;
}
