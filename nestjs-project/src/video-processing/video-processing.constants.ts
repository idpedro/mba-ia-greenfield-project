import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';
export const EXPIRE_STALE_UPLOADS_JOB = 'expire-stale-uploads';
// Interval of the `expire-stale-uploads` job scheduler (TD-08).
export const EXPIRE_STALE_UPLOADS_EVERY_MS = 3_600_000;

export type ProcessVideoJobData = { videoId: string };

// The producer adds `jobId: videoId` per enqueue so a duplicate add is ignored.
export const PROCESS_VIDEO_JOB_OPTIONS: Readonly<Omit<JobsOptions, 'jobId'>> = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: 1000,
};
