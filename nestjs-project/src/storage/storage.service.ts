import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  S3_ERROR_NAMES,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';
import {
  InvalidUploadPartsError,
  MultipartUploadNotFoundError,
  StorageObjectNotFoundError,
} from './storage.errors';
import type {
  CompletedPart,
  SignGetUrlOptions,
  StorageObjectHead,
  UploadedPart,
} from './storage.types';

const INVALID_PARTS_ERROR_NAMES: ReadonlySet<string> = new Set([
  S3_ERROR_NAMES.INVALID_PART,
  S3_ERROR_NAMES.INVALID_PART_ORDER,
  S3_ERROR_NAMES.ENTITY_TOO_SMALL,
]);

const OBJECT_NOT_FOUND_ERROR_NAMES: ReadonlySet<string> = new Set([
  S3_ERROR_NAMES.NOT_FOUND,
  S3_ERROR_NAMES.NO_SUCH_KEY,
]);

const isS3Error = (error: unknown, names: ReadonlySet<string>): boolean =>
  error instanceof S3ServiceException && names.has(error.name);

const isNoSuchUpload = (error: unknown): boolean =>
  error instanceof S3ServiceException &&
  error.name === S3_ERROR_NAMES.NO_SUCH_UPLOAD;

@Injectable()
export class StorageService {
  private readonly bucket: string;

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const output = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!output.UploadId) {
      throw new Error(`Storage returned no UploadId for key ${key}`);
    }
    return output.UploadId;
  }

  async signUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  /** Returns every uploaded part (all pages), ordered by part number. */
  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;

    try {
      do {
        const output = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );
        for (const part of output.Parts ?? []) {
          if (part.PartNumber === undefined || part.ETag === undefined) {
            continue;
          }
          parts.push({
            partNumber: part.PartNumber,
            etag: part.ETag,
            size: part.Size ?? 0,
          });
        }
        partNumberMarker = output.IsTruncated
          ? output.NextPartNumberMarker
          : undefined;
      } while (partNumberMarker !== undefined);
    } catch (error) {
      if (isNoSuchUpload(error)) {
        throw new MultipartUploadNotFoundError(key, uploadId, {
          cause: error,
        });
      }
      throw error;
    }

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) {
        throw new MultipartUploadNotFoundError(key, uploadId, {
          cause: error,
        });
      }
      if (isS3Error(error, INVALID_PARTS_ERROR_NAMES)) {
        throw new InvalidUploadPartsError(key, (error as Error).name, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) {
        throw new MultipartUploadNotFoundError(key, uploadId, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async headObject(key: string): Promise<StorageObjectHead> {
    try {
      const output = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: output.ContentLength ?? 0,
        contentType: output.ContentType,
      };
    } catch (error) {
      if (isS3Error(error, OBJECT_NOT_FOUND_ERROR_NAMES)) {
        throw new StorageObjectNotFoundError(key, { cause: error });
      }
      throw error;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async signGetUrl(key: string, options: SignGetUrlOptions): Promise<string> {
    const client =
      options.client === 'public' ? this.publicClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }
}
