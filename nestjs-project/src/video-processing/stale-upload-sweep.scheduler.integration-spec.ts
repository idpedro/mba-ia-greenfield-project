import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { StaleUploadSweepScheduler } from './stale-upload-sweep.scheduler';
import {
  EXPIRE_STALE_UPLOADS_JOB,
  VIDEO_MAINTENANCE_QUEUE,
} from './video-processing.constants';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Real Redis. The queue lives under a per-suite key prefix, so the running
 * `video-worker` and its real scheduler are never touched.
 */
describe('StaleUploadSweepScheduler (integration)', () => {
  const prefix = `test-${randomUUID()}`;
  let inspector: Queue;

  /** Boots and shuts down a worker-like graph, as a worker restart does. */
  const bootOnce = async (): Promise<void> => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_MAINTENANCE_QUEUE, prefix }),
      ],
      providers: [StaleUploadSweepScheduler],
    }).compile();
    // init() runs onApplicationBootstrap, which upserts the scheduler.
    await module.init();
    await module.close();
  };

  beforeAll(() => {
    const { host, port } = queueConfig();
    inspector = new Queue(VIDEO_MAINTENANCE_QUEUE, {
      connection: { host, port },
      prefix,
    });
  });

  afterAll(async () => {
    await inspector.removeJobScheduler(EXPIRE_STALE_UPLOADS_JOB);
    await inspector.obliterate({ force: true });
    await inspector.close();
  });

  it('should leave exactly one hourly expire-stale-uploads scheduler after two boots', async () => {
    await bootOnce();
    await bootOnce();

    const schedulers = await inspector.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: EXPIRE_STALE_UPLOADS_JOB,
      name: EXPIRE_STALE_UPLOADS_JOB,
      every: ONE_HOUR_MS,
    });
    await expect(inspector.getJobSchedulersCount()).resolves.toBe(1);
  });
});
