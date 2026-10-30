import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing';
import { QueueModule } from './queue.module';

// A per-suite key prefix keeps test jobs away from the real queue keys.
const buildModule = (
  prefix: string,
  config?: { host: string; port: number },
): Promise<TestingModule> => {
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
      QueueModule,
      BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, prefix }),
    ],
  });
  if (config) {
    builder.overrideProvider(queueConfig.KEY).useValue(config);
  }
  return builder.compile();
};

describe('QueueModule (integration)', () => {
  describe('against the redis service', () => {
    const prefix = `test-${randomUUID()}`;
    let module: TestingModule;
    let queue: Queue<ProcessVideoJobData>;

    beforeAll(async () => {
      module = await buildModule(prefix);
      await module.init();
      queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    });

    afterAll(async () => {
      await queue.obliterate({ force: true });
      await module.close();
    });

    it('should connect to the host and port from queueConfig', async () => {
      const config = module.get<ReturnType<typeof queueConfig>>(
        queueConfig.KEY,
      );

      await expect(queue.waitUntilReady()).resolves.toBeUndefined();
      expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
      expect(queue.opts.connection).toMatchObject({
        host: config.host,
        port: config.port,
      });
    });

    it('should ignore a duplicate process-video enqueue for the same videoId', async () => {
      const videoId = randomUUID();
      const opts = { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId };

      await queue.add(PROCESS_VIDEO_JOB, { videoId }, opts);
      await queue.add(PROCESS_VIDEO_JOB, { videoId }, opts);

      const job = await queue.getJob(videoId);
      expect(await queue.getJobCountByTypes('waiting')).toBe(1);
      expect(job?.data).toEqual({ videoId });
      expect(job?.opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: true,
        removeOnFail: 1000,
      });
    });
  });

  describe('when redis is unreachable', () => {
    it('should emit a connection error instead of failing silently', async () => {
      // Port 6390 has no listener on the redis service: connection refused.
      const module = await buildModule(`test-${randomUUID()}`, {
        host: 'redis',
        port: 6390,
      });
      await module.init();
      const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

      const error = await new Promise<Error>((resolve) =>
        queue.once('error', resolve),
      );

      // close() runs the queue shutdown hook, which also stops the retries.
      await module.close();

      expect(error.message).toMatch(/ECONNREFUSED/);
    });
  });
});
