import type { S3Client } from '@aws-sdk/client-s3';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import storageConfig from '../../config/storage.config';
import { StorageModule, StorageService } from '../../storage';
import {
  buildTestStorageConfig,
  createTestS3Client,
  deleteTestBucket,
} from '../../test/storage';
import {
  createMediaFixtures,
  type MediaFixtures,
} from '../../test/video-fixture';
import { InvalidMediaError, MediaToolError } from './ffmpeg.errors';
import { FfmpegService, thumbnailTimestamp } from './ffmpeg.service';

const execFileAsync = promisify(execFile);

const URL_TTL_SECONDS = 300;
const FIXTURE_DURATION_SECONDS = 3;
const FIXTURE_WIDTH = 640;
const FIXTURE_HEIGHT = 360;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

interface ImageProbe {
  streams: { codec_name: string; width: number; height: number }[];
}

/**
 * Runs the real ffprobe/ffmpeg binaries over fixtures served by signed URLs of
 * the internal `rustfs` client, as the worker does.
 */
describe('FfmpegService (integration)', () => {
  const config = buildTestStorageConfig();
  let app: INestApplicationContext;
  let service: FfmpegService;
  let storage: StorageService;
  let adminClient: S3Client;
  let withAudio: MediaFixtures;
  let withoutAudio: MediaFixtures;
  let outputDir: string;

  const uploadAndSign = async (path: string): Promise<string> => {
    const key = `videos/${randomUUID()}/original`;
    await storage.putObject(key, await readFile(path), 'video/mp4');
    return storage.signGetUrl(key, {
      expiresIn: URL_TTL_SECONDS,
      client: 'internal',
    });
  };

  beforeAll(async () => {
    [withAudio, withoutAudio] = await Promise.all([
      createMediaFixtures({ durationSeconds: FIXTURE_DURATION_SECONDS }),
      createMediaFixtures({
        durationSeconds: FIXTURE_DURATION_SECONDS,
        withAudio: false,
      }),
    ]);
    outputDir = await mkdtemp(join(tmpdir(), 'streamtube-frames-'));

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [FfmpegService],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .compile();

    // init() runs the bucket bootstrap for the throwaway bucket.
    app = await module.init();
    service = app.get(FfmpegService);
    storage = app.get(StorageService);
    adminClient = createTestS3Client(config);
  }, 60000);

  afterAll(async () => {
    await deleteTestBucket(adminClient, config.bucket);
    adminClient.destroy();
    await app.close();
    await Promise.all([
      withAudio.cleanup(),
      withoutAudio.cleanup(),
      rm(outputDir, { recursive: true, force: true }),
    ]);
  });

  describe('probe', () => {
    it('should read duration, dimensions and codecs of a video with audio', async () => {
      const url = await uploadAndSign(withAudio.videoPath);

      const result = await service.probe(url);

      expect(result.durationSeconds).toBeCloseTo(FIXTURE_DURATION_SECONDS, 0);
      expect(result).toMatchObject({
        width: FIXTURE_WIDTH,
        height: FIXTURE_HEIGHT,
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
      expect(result.containerFormat).toContain('mp4');
      expect(result.bitrate).toBeGreaterThan(0);
    });

    it('should return audioCodec null for a video without an audio track', async () => {
      const url = await uploadAndSign(withoutAudio.videoPath);

      const result = await service.probe(url);

      expect(result.audioCodec).toBeNull();
      expect(result.videoCodec).toBe('h264');
    });

    it('should throw InvalidMediaError for a file that is not a video', async () => {
      const url = await uploadAndSign(withAudio.nonVideoPath);

      await expect(service.probe(url)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should throw MediaToolError when the object cannot be fetched', async () => {
      const url = await storage.signGetUrl(`videos/${randomUUID()}/missing`, {
        expiresIn: URL_TTL_SECONDS,
        client: 'internal',
      });

      await expect(service.probe(url)).rejects.toBeInstanceOf(MediaToolError);
    });
  });

  describe('extractFrame', () => {
    it('should write a 1280px-wide JPEG preserving the source aspect ratio', async () => {
      const url = await uploadAndSign(withAudio.videoPath);
      const outputPath = join(outputDir, `${randomUUID()}.jpg`);

      await service.extractFrame(
        url,
        thumbnailTimestamp(FIXTURE_DURATION_SECONDS),
        outputPath,
      );

      const image = await readFile(outputPath);
      expect(image.subarray(0, JPEG_MAGIC.length)).toEqual(JPEG_MAGIC);
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        outputPath,
      ]);
      const [stream] = (JSON.parse(stdout) as ImageProbe).streams;
      expect(stream.codec_name).toBe('mjpeg');
      expect(stream.width).toBe(1280);
      expect(stream.height).toBe((1280 * FIXTURE_HEIGHT) / FIXTURE_WIDTH);
    });
  });
});
