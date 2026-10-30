import {
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import storageConfig from '../config/storage.config';
import {
  buildTestStorageConfig,
  createTestS3Client,
  deleteTestBucket,
} from '../test/storage';
import { createMediaFixtures, type MediaFixtures } from '../test/video-fixture';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import type { CompletedPart } from './storage.types';

const execFileAsync = promisify(execFile);

const VIDEO_CONTENT_TYPE = 'video/mp4';
const URL_TTL_SECONDS = 300;
// S3 rejects non-final parts smaller than 5 MiB on complete.
const PART_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_ORIGIN = 'http://app.streamtube.test';

interface FfprobeOutput {
  streams: { codec_type: string }[];
}

/**
 * Compatibility gate (TD-02): proves, against the real `rustfs` service, every
 * S3 operation the phase depends on. Requests outside the SDK use `fetch`, as
 * the browser and ffprobe do.
 */
describe('Storage compatibility gate (integration)', () => {
  const config = buildTestStorageConfig({
    corsAllowedOrigins: [ALLOWED_ORIGIN],
  });
  let app: INestApplicationContext;
  let service: StorageService;
  let adminClient: S3Client;
  let fixtures: MediaFixtures;
  let video: Buffer;

  const newKey = (): string => `videos/${randomUUID()}/source`;

  const putPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<Response> => {
    const url = await service.signUploadPartUrl(
      key,
      uploadId,
      partNumber,
      URL_TTL_SECONDS,
    );
    return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  };

  const uploadPartForEtag = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> => {
    const response = await putPart(key, uploadId, partNumber, body);
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag as string;
  };

  const splitInTwoParts = (body: Buffer): [Buffer, Buffer] => [
    body.subarray(0, PART_SIZE_BYTES),
    body.subarray(PART_SIZE_BYTES),
  ];

  const uploadInTwoParts = async (key: string, body: Buffer): Promise<void> => {
    const uploadId = await service.createMultipartUpload(
      key,
      VIDEO_CONTENT_TYPE,
    );
    const parts: CompletedPart[] = [];
    for (const [index, chunk] of splitInTwoParts(body).entries()) {
      const partNumber = index + 1;
      const etag = await uploadPartForEtag(key, uploadId, partNumber, chunk);
      parts.push({ partNumber, etag });
    }
    await service.completeMultipartUpload(key, uploadId, parts);
  };

  beforeAll(async () => {
    fixtures = await createMediaFixtures();
    video = await readFile(fixtures.videoPath);
    // The split below needs a second, non-empty part.
    expect(video.length).toBeGreaterThan(PART_SIZE_BYTES);

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .compile();

    // init() runs the bucket bootstrap (bucket, CORS and lifecycle).
    app = await module.init();
    service = app.get(StorageService);
    adminClient = createTestS3Client(config);
  }, 60000);

  afterAll(async () => {
    await deleteTestBucket(adminClient, config.bucket);
    adminClient.destroy();
    await app.close();
    await fixtures.cleanup();
  });

  describe('multipart upload through signed part URLs', () => {
    it('should accept a part PUT on a signed URL and return its ETag', async () => {
      const key = newKey();
      const uploadId = await service.createMultipartUpload(
        key,
        VIDEO_CONTENT_TYPE,
      );
      const [firstPart] = splitInTwoParts(video);

      const response = await putPart(key, uploadId, 1, firstPart);

      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toMatch(/^"?[0-9a-f-]+"?$/i);
    });

    it('should list the parts of a partially uploaded object', async () => {
      const key = newKey();
      const uploadId = await service.createMultipartUpload(
        key,
        VIDEO_CONTENT_TYPE,
      );
      const [firstPart] = splitInTwoParts(video);
      const etag = await uploadPartForEtag(key, uploadId, 1, firstPart);

      const parts = await service.listParts(key, uploadId);

      expect(parts).toEqual([{ partNumber: 1, etag, size: firstPart.length }]);
    });

    it('should complete two parts by their ETags into an object of the summed length', async () => {
      const key = newKey();
      const [firstPart, secondPart] = splitInTwoParts(video);

      await uploadInTwoParts(key, video);
      const head = await service.headObject(key);

      expect(head.contentLength).toBe(firstPart.length + secondPart.length);
      expect(head.contentType).toBe(VIDEO_CONTENT_TYPE);
    });
  });

  describe('reads of a completed object', () => {
    const key = newKey();

    beforeAll(async () => {
      await uploadInTwoParts(key, video);
    }, 60000);

    it('should answer a Range request with 206 and exactly the requested bytes', async () => {
      const url = await service.signGetUrl(key, {
        expiresIn: URL_TTL_SECONDS,
        client: 'public',
      });

      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 0-1023/${video.length}`,
      );
      expect(body.length).toBe(1024);
      expect(body.equals(video.subarray(0, 1024))).toBe(true);
    });

    it('should return the attachment Content-Disposition requested in the signed URL', async () => {
      const disposition = 'attachment; filename="sample.mp4"';
      const url = await service.signGetUrl(key, {
        expiresIn: URL_TTL_SECONDS,
        client: 'public',
        contentDisposition: disposition,
      });

      const response = await fetch(url);
      await response.body?.cancel();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toMatch(
        /^attachment/,
      );
      expect(response.headers.get('content-disposition')).toBe(disposition);
    });

    it('should round-trip a non-ASCII filename* in the Content-Disposition', async () => {
      const disposition = `attachment; filename="video.mp4"; filename*=UTF-8''${encodeURIComponent('vídeo.mp4')}`;
      const url = await service.signGetUrl(key, {
        expiresIn: URL_TTL_SECONDS,
        client: 'public',
        contentDisposition: disposition,
      });

      const response = await fetch(url);
      await response.body?.cancel();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(disposition);
    });

    it('should let ffprobe read the object through a signed URL', async () => {
      const url = await service.signGetUrl(key, {
        expiresIn: URL_TTL_SECONDS,
        client: 'internal',
      });

      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        url,
      ]);
      const probe = JSON.parse(stdout) as FfprobeOutput;

      expect(probe.streams.map((stream) => stream.codec_type)).toContain(
        'video',
      );
    });
  });

  describe('bucket configuration', () => {
    const signPartUrlForNewUpload = async (): Promise<string> => {
      const key = newKey();
      const uploadId = await service.createMultipartUpload(
        key,
        VIDEO_CONTENT_TYPE,
      );
      return service.signUploadPartUrl(key, uploadId, 1, URL_TTL_SECONDS);
    };

    it('should approve the PUT preflight of an allowed origin', async () => {
      const url = await signPartUrlForNewUpload();

      const response = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        },
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        ALLOWED_ORIGIN,
      );
      expect(response.headers.get('access-control-allow-methods')).toMatch(
        /\bPUT\b/,
      );
      expect(
        response.headers.get('access-control-allow-headers')?.toLowerCase(),
      ).toContain('content-type');
    });

    // Browsers read Access-Control-Expose-Headers from the actual response,
    // not from the preflight (Fetch standard), so ETag is checked on the PUT.
    it('should expose ETag to an allowed origin on the part PUT response', async () => {
      const url = await signPartUrlForNewUpload();
      const [firstPart] = splitInTwoParts(video);

      const response = await fetch(url, {
        method: 'PUT',
        headers: { Origin: ALLOWED_ORIGIN },
        body: new Uint8Array(firstPart),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        ALLOWED_ORIGIN,
      );
      expect(
        response.headers.get('access-control-expose-headers')?.toLowerCase(),
      ).toContain('etag');
    });

    it('should read back the AbortIncompleteMultipartUpload lifecycle rule', async () => {
      const lifecycle = await adminClient.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: config.bucket }),
      );

      expect(lifecycle.Rules).toEqual([
        expect.objectContaining({
          Status: 'Enabled',
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
        }),
      ]);
    });
  });
});
