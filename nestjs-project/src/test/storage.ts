import {
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';

export type StorageTestConfig = ReturnType<typeof storageConfig>;

/** Storage config pointing at a throwaway bucket, isolated from the dev bucket. */
export function buildTestStorageConfig(
  overrides: Partial<StorageTestConfig> = {},
): StorageTestConfig {
  return {
    ...storageConfig(),
    bucket: `streamtube-test-${randomUUID()}`,
    ...overrides,
  };
}

/** Admin client over the internal endpoint, for test setup and assertions. */
export function createTestS3Client(config: StorageTestConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/** Aborts open uploads, deletes every object and then the bucket itself. */
export async function deleteTestBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  try {
    const uploads = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket }),
    );
    for (const upload of uploads.Uploads ?? []) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    }
    const objects = await client.send(
      new ListObjectsV2Command({ Bucket: bucket }),
    );
    for (const object of objects.Contents ?? []) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
      );
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (error instanceof S3ServiceException && error.name === 'NoSuchBucket') {
      return;
    }
    throw error;
  }
}
