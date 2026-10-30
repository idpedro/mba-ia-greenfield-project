import {
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Queue, UnrecoverableError, type Job } from 'bullmq';
import { execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageService } from '../storage';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  buildTestStorageConfig,
  createTestS3Client,
  deleteTestBucket,
} from '../test/storage';
import { createMediaFixtures, type MediaFixtures } from '../test/video-fixture';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../videos/video.enums';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingProcessor } from './video-processing.processor';

const execFileAsync = promisify(execFile);

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURE_DURATION_SECONDS = 3;
const FIXTURE_WIDTH = 640;
const FIXTURE_HEIGHT = 360;
const THUMBNAIL_WIDTH = 1280;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const JOB_TIMEOUT_MS = 30_000;

interface ImageProbe {
  streams: { codec_name: string; width: number; height: number }[];
}

/**
 * Real db, rustfs and ffmpeg. The processor's BullMQ worker is bound to a
 * per-suite key prefix and the objects live in a throwaway bucket, so neither
 * the running `video-worker` nor the dev bucket is involved.
 */
describe('VideoProcessingProcessor (integration)', () => {
  const config = buildTestStorageConfig();
  const queuePrefix = `test-${randomUUID()}`;
  let queue: Queue<ProcessVideoJobData>;
  let maintenanceQueue: Queue;
  let module: TestingModule;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let adminClient: S3Client;
  let fixtures: MediaFixtures;
  let workDir: string;
  let userCounter = 0;

  const createProcessingVideo = async (sourcePath: string): Promise<Video> => {
    const n = ++userCounter;
    const user = await dataSource.getRepository(User).save({
      email: `video_processing_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `chan${n}`,
      nickname: `video_processing_${n}`,
      user_id: user.id,
    });
    const id = randomUUID();
    const originalKey = `videos/${id}/original`;
    const body = await readFile(sourcePath);
    await storage.putObject(originalKey, body, 'video/mp4');
    return videoRepository.save({
      id,
      channel_id: channel.id,
      slug: randomBytes(8).toString('base64url').slice(0, 11),
      title: 'sample',
      original_filename: 'sample.mp4',
      mime_type: 'video/mp4',
      declared_size_bytes: body.length,
      size_bytes: body.length,
      processing_status: VideoProcessingStatus.PROCESSING,
      original_key: originalKey,
    });
  };

  const jobFor = (videoId: string): Job<ProcessVideoJobData> =>
    ({
      data: { videoId },
      attemptsMade: 0,
      opts: { ...PROCESS_VIDEO_JOB_OPTIONS },
    }) as unknown as Job<ProcessVideoJobData>;

  const headThumbnail = (videoId: string) =>
    adminClient.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: `videos/${videoId}/thumbnail.jpg`,
      }),
    );

  /** Enqueues on the isolated queue, without backoff, and waits for failure. */
  const runUntilFailed = async (
    videoId: string,
  ): Promise<Job<ProcessVideoJobData>> => {
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { ...PROCESS_VIDEO_JOB_OPTIONS, backoff: undefined, jobId: videoId },
    );
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await queue.getJobState(videoId)) === 'failed') {
        const job = await queue.getJob(videoId);
        return job as Job<ProcessVideoJobData>;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Job ${videoId} did not fail within ${JOB_TIMEOUT_MS}ms`);
  };

  beforeAll(async () => {
    fixtures = await createMediaFixtures({
      durationSeconds: FIXTURE_DURATION_SECONDS,
    });
    workDir = await mkdtemp(join(tmpdir(), 'streamtube-processor-test-'));
    const { host, port } = queueConfig();
    queue = new Queue<ProcessVideoJobData>(VIDEO_PROCESSING_QUEUE, {
      connection: { host, port },
      prefix: queuePrefix,
    });
    // The module also hosts the stale-upload sweep: isolate its queue too.
    maintenanceQueue = new Queue(VIDEO_MAINTENANCE_QUEUE, {
      connection: { host, port },
      prefix: queuePrefix,
    });

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        // The schema comes from the migrations, not a synchronized copy.
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        QueueModule,
        VideoProcessingModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      // The processor's worker takes its prefix from this queue.
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue(queue)
      .overrideProvider(getQueueToken(VIDEO_MAINTENANCE_QUEUE))
      .useValue(maintenanceQueue)
      .compile();

    // init() runs the bucket bootstrap and starts the isolated worker.
    await module.init();
    processor = module.get(VideoProcessingProcessor);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    adminClient = createTestS3Client(config);
  }, 60000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await module.close();
    await maintenanceQueue.obliterate({ force: true });
    await queue.close();
    await maintenanceQueue.close();
    await deleteTestBucket(adminClient, config.bucket);
    adminClient.destroy();
    await fixtures.cleanup();
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should leave a valid upload ready with its metadata', async () => {
    const video = await createProcessingVideo(fixtures.videoPath);

    await processor.process(jobFor(video.id));

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted).toMatchObject({
      processing_status: VideoProcessingStatus.READY,
      failure_reason: null,
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
    });
    expect(persisted.duration_seconds).toBeCloseTo(FIXTURE_DURATION_SECONDS, 0);
    expect(persisted.container_format).toContain('mp4');
    expect(persisted.bitrate).toBeGreaterThan(0);
    expect(persisted.processed_at).toBeInstanceOf(Date);
  });

  it('should store a 1280px-wide JPEG thumbnail in the bucket', async () => {
    const video = await createProcessingVideo(fixtures.videoPath);

    await processor.process(jobFor(video.id));

    const head = await headThumbnail(video.id);
    expect(head.ContentType).toBe('image/jpeg');
    const object = await adminClient.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: `videos/${video.id}/thumbnail.jpg`,
      }),
    );
    const image = Buffer.from(await object.Body!.transformToByteArray());
    expect(image.subarray(0, JPEG_MAGIC.length)).toEqual(JPEG_MAGIC);
    const imagePath = join(workDir, `${video.id}.jpg`);
    await writeFile(imagePath, image);
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      imagePath,
    ]);
    const [stream] = (JSON.parse(stdout) as ImageProbe).streams;
    expect(stream.codec_name).toBe('mjpeg');
    expect(stream.width).toBe(THUMBNAIL_WIDTH);
    expect(stream.height).toBe(
      (THUMBNAIL_WIDTH * FIXTURE_HEIGHT) / FIXTURE_WIDTH,
    );
  });

  it('should change neither the row nor the thumbnail on a repeated delivery', async () => {
    const video = await createProcessingVideo(fixtures.videoPath);
    await processor.process(jobFor(video.id));
    const before = await videoRepository.findOneByOrFail({ id: video.id });
    const thumbnailBefore = await headThumbnail(video.id);

    await processor.process(jobFor(video.id));

    const after = await videoRepository.findOneByOrFail({ id: video.id });
    const thumbnailAfter = await headThumbnail(video.id);
    expect(after).toEqual(before);
    expect(thumbnailAfter.ETag).toBe(thumbnailBefore.ETag);
    expect(thumbnailAfter.LastModified).toEqual(thumbnailBefore.LastModified);
  });

  it('should mark a file that is not a video as failed with invalid_media', async () => {
    const video = await createProcessingVideo(fixtures.nonVideoPath);

    await expect(processor.process(jobFor(video.id))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted).toMatchObject({
      processing_status: VideoProcessingStatus.FAILED,
      failure_reason: VideoFailureReason.INVALID_MEDIA,
      thumbnail_key: null,
      processed_at: null,
    });
    await expect(headThumbnail(video.id)).rejects.toMatchObject({
      name: 'NotFound',
    });
  });

  describe('through the BullMQ worker', () => {
    it('should fail a non-video job after a single attempt', async () => {
      const video = await createProcessingVideo(fixtures.nonVideoPath);

      const job = await runUntilFailed(video.id);

      expect(job.attemptsMade).toBe(1);
      const persisted = await videoRepository.findOneByOrFail({
        id: video.id,
      });
      expect(persisted.failure_reason).toBe(VideoFailureReason.INVALID_MEDIA);
    });

    it('should mark the video failed with processing_error after every attempt fails on storage', async () => {
      const video = await createProcessingVideo(fixtures.videoPath);
      const signGetUrl = jest
        .spyOn(storage, 'signGetUrl')
        .mockRejectedValue(new Error('connect ECONNREFUSED rustfs:9000'));

      const job = await runUntilFailed(video.id);

      expect(job.attemptsMade).toBe(PROCESS_VIDEO_JOB_OPTIONS.attempts);
      expect(signGetUrl).toHaveBeenCalledTimes(
        PROCESS_VIDEO_JOB_OPTIONS.attempts as number,
      );
      const persisted = await videoRepository.findOneByOrFail({
        id: video.id,
      });
      expect(persisted).toMatchObject({
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.PROCESSING_ERROR,
      });
    });
  });
});
