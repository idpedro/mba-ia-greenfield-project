import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  EXPIRE_STALE_UPLOADS_EVERY_MS,
  EXPIRE_STALE_UPLOADS_JOB,
  VIDEO_MAINTENANCE_QUEUE,
} from './video-processing.constants';

/**
 * Registers the hourly `expire-stale-uploads` job on every worker boot.
 * Upserting by scheduler id is idempotent, so restarts never add a second
 * schedule (TD-08).
 */
@Injectable()
export class StaleUploadSweepScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EXPIRE_STALE_UPLOADS_JOB,
      { every: EXPIRE_STALE_UPLOADS_EVERY_MS },
      { name: EXPIRE_STALE_UPLOADS_JOB },
    );
  }
}
