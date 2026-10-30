import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { StorageService } from '../storage';
import { Video } from '../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../videos/video.enums';
import { InvalidMediaError } from './ffmpeg/ffmpeg.errors';
import { FfmpegService, thumbnailTimestamp } from './ffmpeg/ffmpeg.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

// Covers the probe and the frame extraction, which only fetch byte ranges.
export const SOURCE_URL_TTL_SECONDS = 3600;
export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

export const thumbnailKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;

/**
 * Consumes `process-video` in the worker process only (TD-10): reads the
 * metadata of the uploaded original, stores its thumbnail and moves the video
 * to `ready`, or to `failed` once the failure is terminal (TD-09).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneBy({ id: videoId });
    // Repeated delivery after the outcome was stored, or a deleted video:
    // nothing left to do (TD-07).
    if (video?.processing_status !== VideoProcessingStatus.PROCESSING) {
      this.logger.log(
        `Skipping video ${videoId}: status is ${video?.processing_status ?? 'missing'}`,
      );
      return;
    }

    try {
      await this.processVideo(video);
    } catch (error) {
      throw await this.handleFailure(job, video, error);
    }
  }

  private async processVideo(video: Video): Promise<void> {
    const sourceUrl = await this.storage.signGetUrl(video.original_key, {
      expiresIn: SOURCE_URL_TTL_SECONDS,
      client: 'internal',
    });
    const metadata = await this.ffmpeg.probe(sourceUrl);
    const key = thumbnailKey(video.id);

    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-thumbnail-'));
    try {
      const framePath = join(workDir, 'thumbnail.jpg');
      await this.ffmpeg.extractFrame(
        sourceUrl,
        thumbnailTimestamp(metadata.durationSeconds),
        framePath,
      );
      await this.storage.putObject(
        key,
        await readFile(framePath),
        THUMBNAIL_CONTENT_TYPE,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }

    // One update, guarded by status, so a concurrent outcome is not overwritten.
    await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.PROCESSING },
      {
        duration_seconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        video_codec: metadata.videoCodec,
        audio_codec: metadata.audioCodec,
        container_format: metadata.containerFormat,
        bitrate: metadata.bitrate,
        thumbnail_key: key,
        processed_at: new Date(),
        processing_status: VideoProcessingStatus.READY,
      },
    );
    this.logger.log(`Video ${video.id} is ready`);
  }

  /**
   * Marks the video `failed` when BullMQ will not retry the job, and returns
   * the error to rethrow: bad media becomes an `UnrecoverableError` so the
   * remaining attempts are skipped (TD-09).
   */
  private async handleFailure(
    job: Job<ProcessVideoJobData>,
    video: Video,
    error: unknown,
  ): Promise<unknown> {
    const invalidMedia = error instanceof InvalidMediaError;
    const unrecoverable = invalidMedia || error instanceof UnrecoverableError;
    // attemptsMade counts the attempts that already failed, not this one.
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const message = error instanceof Error ? error.message : String(error);

    if (unrecoverable || lastAttempt) {
      const reason = invalidMedia
        ? VideoFailureReason.INVALID_MEDIA
        : VideoFailureReason.PROCESSING_ERROR;
      this.logger.error(`Video ${video.id} failed (${reason}): ${message}`);
      await this.markFailed(video.id, reason);
    } else {
      this.logger.warn(
        `Video ${video.id} attempt ${job.attemptsMade + 1} failed, will retry: ${message}`,
      );
    }

    return invalidMedia ? new UnrecoverableError(message) : error;
  }

  private async markFailed(
    videoId: string,
    reason: VideoFailureReason,
  ): Promise<void> {
    try {
      await this.videoRepository.update(
        { id: videoId, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: reason,
        },
      );
    } catch (persistError) {
      // The job error is still rethrown; this one is only logged.
      this.logger.error(
        `Could not mark video ${videoId} as failed: ${String(persistError)}`,
      );
    }
  }
}
