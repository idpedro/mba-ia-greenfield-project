import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import {
  buildTestStorageConfig,
  createTestS3Client,
  deleteTestBucket,
} from '../test/storage';
import {
  InvalidUploadPartsError,
  MultipartUploadNotFoundError,
  StorageObjectNotFoundError,
} from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const VIDEO_CONTENT_TYPE = 'video/mp4';
const URL_TTL_SECONDS = 300;

describe('StorageService (integration)', () => {
  const config = buildTestStorageConfig();
  let app: INestApplicationContext;
  let service: StorageService;
  let adminClient: S3Client;

  const newKey = (): string => `videos/${randomUUID()}/source`;

  const uploadPartViaSignedUrl = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> => {
    const url = await service.signUploadPartUrl(
      key,
      uploadId,
      partNumber,
      URL_TTL_SECONDS,
    );
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag as string;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .compile();

    // init() runs the bucket bootstrap, so the throwaway bucket exists.
    app = await module.init();
    service = app.get(StorageService);
    adminClient = createTestS3Client(config);
  }, 30000);

  afterAll(async () => {
    await deleteTestBucket(adminClient, config.bucket);
    adminClient.destroy();
    await app.close();
  });

  it('should complete a multipart upload sent through a signed part URL', async () => {
    const key = newKey();
    const body = randomBytes(1024 * 64);
    const uploadId = await service.createMultipartUpload(
      key,
      VIDEO_CONTENT_TYPE,
    );

    const etag = await uploadPartViaSignedUrl(key, uploadId, 1, body);
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);
    const head = await service.headObject(key);

    expect(head.contentLength).toBe(body.length);
    expect(head.contentType).toBe(VIDEO_CONTENT_TYPE);
  });

  it('should list the parts already uploaded for a multipart upload', async () => {
    const key = newKey();
    const body = randomBytes(1024);
    const uploadId = await service.createMultipartUpload(
      key,
      VIDEO_CONTENT_TYPE,
    );
    const etag = await uploadPartViaSignedUrl(key, uploadId, 1, body);

    const parts = await service.listParts(key, uploadId);

    expect(parts).toEqual([{ partNumber: 1, etag, size: body.length }]);
  });

  it('should make the upload id unusable after abort', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(
      key,
      VIDEO_CONTENT_TYPE,
    );

    await service.abortMultipartUpload(key, uploadId);

    await expect(service.listParts(key, uploadId)).rejects.toBeInstanceOf(
      MultipartUploadNotFoundError,
    );
  });

  it('should translate NoSuchUpload on complete into MultipartUploadNotFoundError', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(
      key,
      VIDEO_CONTENT_TYPE,
    );
    const etag = await uploadPartViaSignedUrl(
      key,
      uploadId,
      1,
      randomBytes(1024),
    );
    await service.abortMultipartUpload(key, uploadId);

    await expect(
      service.completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag }]),
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
  });

  it('should translate a non-existent part on complete into InvalidUploadPartsError', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(
      key,
      VIDEO_CONTENT_TYPE,
    );
    const etag = await uploadPartViaSignedUrl(
      key,
      uploadId,
      1,
      randomBytes(1024),
    );

    const completion = service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
      { partNumber: 2, etag },
    ]);

    await expect(completion).rejects.toBeInstanceOf(InvalidUploadPartsError);
  });

  it('should translate a missing object on head into StorageObjectNotFoundError', async () => {
    await expect(service.headObject(newKey())).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  it('should store, read through an internal signed URL and delete an object', async () => {
    const key = `videos/${randomUUID()}/thumbnail.jpg`;
    const body = randomBytes(2048);

    await service.putObject(key, body, 'image/jpeg');
    const url = await service.signGetUrl(key, {
      expiresIn: URL_TTL_SECONDS,
      client: 'internal',
    });
    const response = await fetch(url);
    const downloaded = Buffer.from(await response.arrayBuffer());
    await service.deleteObject(key);

    expect(response.status).toBe(200);
    expect(downloaded.equals(body)).toBe(true);
    await expect(service.headObject(key)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  it('should sign read URLs that force the requested content disposition', async () => {
    const key = `videos/${randomUUID()}/source`;
    await service.putObject(key, randomBytes(512), VIDEO_CONTENT_TYPE);
    const disposition = 'attachment; filename="video.mp4"';

    const url = await service.signGetUrl(key, {
      expiresIn: URL_TTL_SECONDS,
      client: 'public',
      contentDisposition: disposition,
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(disposition);
  });

  it('should keep the object readable by the SDK after a multipart upload', async () => {
    const key = newKey();
    const body = randomBytes(4096);
    const uploadId = await service.createMultipartUpload(
      key,
      VIDEO_CONTENT_TYPE,
    );
    const etag = await uploadPartViaSignedUrl(key, uploadId, 1, body);
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    const output = await adminClient.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    const stored = Buffer.from(await output.Body!.transformToByteArray());

    expect(stored.equals(body)).toBe(true);
  });
});
