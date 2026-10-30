import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { StorageService } from './storage';
import {
  buildTestStorageConfig,
  createTestS3Client,
  deleteTestBucket,
  type StorageTestConfig,
} from './test/storage';
import {
  EXPIRE_STALE_UPLOADS_JOB,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
  VideoProcessingModule,
} from './video-processing';
// Internal provider, inspected only to check where its worker is bound.
// eslint-disable-next-line no-restricted-imports
import { StaleUploadSweepProcessor } from './video-processing/stale-upload-sweep.processor';
// Internal provider, inspected only to check where its worker is bound.
// eslint-disable-next-line no-restricted-imports
import { VideoProcessingProcessor } from './video-processing/video-processing.processor';
import { WorkerModule } from './worker.module';

const PROBE_QUEUE = 'worker-module-probe';

describe('WorkerModule (integration)', () => {
  // Throwaway bucket and key prefix keep the dev bucket and real queues intact.
  const config: StorageTestConfig = buildTestStorageConfig();
  const prefix = `test-${randomUUID()}`;
  let adminClient: S3Client;
  let module: TestingModule;
  let dataSource: DataSource;
  let queue: Queue;
  let maintenanceQueue: Queue;
  let probeQueue: Queue;

  beforeAll(async () => {
    adminClient = createTestS3Client(config);
    const { host, port } = queueConfig();
    // The processor's worker takes its prefix from this queue, so it never
    // consumes the real `video-processing` jobs.
    queue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: { host, port },
      prefix,
    });
    // Same for the sweep's worker and its job scheduler.
    maintenanceQueue = new Queue(VIDEO_MAINTENANCE_QUEUE, {
      connection: { host, port },
      prefix,
    });
    module = await Test.createTestingModule({
      imports: [
        WorkerModule,
        // Probe queue on the worker's root BullMQ connection.
        BullModule.registerQueue({ name: PROBE_QUEUE, prefix }),
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue(queue)
      .overrideProvider(getQueueToken(VIDEO_MAINTENANCE_QUEUE))
      .useValue(maintenanceQueue)
      .compile();
    // init() runs the same lifecycle hooks as createApplicationContext().
    await module.init();
    dataSource = module.get(DataSource);
    probeQueue = module.get(getQueueToken(PROBE_QUEUE));
  }, 30000);

  afterAll(async () => {
    // Only reached open when an earlier assertion failed before shutdown.
    if (dataSource?.isInitialized) {
      await module.close();
    }
    await queue.close();
    await maintenanceQueue.close();
    await deleteTestBucket(adminClient, config.bucket);
    adminClient.destroy();
  });

  it('should connect to the db service', async () => {
    expect(dataSource.isInitialized).toBe(true);
    await expect(dataSource.query('SELECT 1 AS ok')).resolves.toEqual([
      { ok: 1 },
    ]);
  });

  it('should connect to the redis service through the root BullMQ config', async () => {
    await expect(probeQueue.waitUntilReady()).resolves.toBeUndefined();
  });

  it('should bootstrap the storage bucket on the rustfs service', async () => {
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    await expect(
      adminClient.send(new HeadBucketCommand({ Bucket: config.bucket })),
    ).resolves.toBeDefined();
  });

  it('should include the video-processing module', () => {
    expect(module.select(VideoProcessingModule)).toBeDefined();
  });

  it('should register the process-video processor on the isolated queue', () => {
    const processor = module.get(VideoProcessingProcessor);

    expect(processor).toBeInstanceOf(VideoProcessingProcessor);
    expect(processor.worker.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(processor.worker.opts.prefix).toBe(prefix);
  });

  it('should register the stale-upload sweep processor on the isolated queue', () => {
    const processor = module.get(StaleUploadSweepProcessor);

    expect(processor).toBeInstanceOf(StaleUploadSweepProcessor);
    expect(processor.worker.name).toBe(VIDEO_MAINTENANCE_QUEUE);
    expect(processor.worker.opts.prefix).toBe(prefix);
  });

  it('should schedule the hourly stale-upload sweep on boot', async () => {
    await expect(
      maintenanceQueue.getJobScheduler(EXPIRE_STALE_UPLOADS_JOB),
    ).resolves.toMatchObject({
      name: EXPIRE_STALE_UPLOADS_JOB,
      every: 3_600_000,
    });
  });

  it('should close every connection on shutdown', async () => {
    await queue.obliterate({ force: true });
    await maintenanceQueue.removeJobScheduler(EXPIRE_STALE_UPLOADS_JOB);
    await maintenanceQueue.obliterate({ force: true });
    await probeQueue.obliterate({ force: true });

    await module.close();

    expect(dataSource.isInitialized).toBe(false);
  });
});
