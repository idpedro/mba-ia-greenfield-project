import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MultipartUploadNotFoundError, StorageService } from '../storage';
import { Video } from '../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../videos/video.enums';
import { VIDEO_MAINTENANCE_QUEUE } from './video-processing.constants';

/** How long a draft may stay in `pending_upload` before it expires (TD-08). */
export const STALE_UPLOAD_INTERVAL = '24 hours';

export type StaleUploadSweepResult = { expired: number };

/**
 * Consumes `expire-stale-uploads` in the worker process only (TD-10): aborts
 * the multipart upload of every draft left in `pending_upload` for over 24h
 * and marks it `failed` with `upload_expired` (TD-08).
 */
@Processor(VIDEO_MAINTENANCE_QUEUE)
export class StaleUploadSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(StaleUploadSweepProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(): Promise<StaleUploadSweepResult> {
    // The cutoff uses the database clock, the same one that set created_at.
    const staleVideos = await this.videoRepository
      .createQueryBuilder('video')
      .select(['video.id', 'video.upload_id', 'video.original_key'])
      .where('video.processing_status = :status', {
        status: VideoProcessingStatus.PENDING_UPLOAD,
      })
      .andWhere(
        `video.created_at < now() - interval '${STALE_UPLOAD_INTERVAL}'`,
      )
      .getMany();

    let expired = 0;
    for (const video of staleVideos) {
      if (await this.expire(video)) {
        expired++;
      }
    }
    if (staleVideos.length > 0) {
      this.logger.log(
        `Expired ${expired} of ${staleVideos.length} stale uploads`,
      );
    }
    return { expired };
  }

  /** Returns whether the row moved to `failed`. */
  private async expire(video: Video): Promise<boolean> {
    if (video.upload_id) {
      try {
        await this.storage.abortMultipartUpload(
          video.original_key,
          video.upload_id,
        );
      } catch (error) {
        // Already aborted or expired by the bucket lifecycle rule: nothing
        // left to clean up. Any other failure keeps the row for the next run.
        if (!(error instanceof MultipartUploadNotFoundError)) {
          this.logger.error(
            `Could not abort the upload of video ${video.id}: ${String(error)}`,
          );
          return false;
        }
      }
    }

    // Guarded by status, so a concurrent `complete` wins (TD-08).
    const result = await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.PENDING_UPLOAD },
      {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_EXPIRED,
        upload_id: null,
      },
    );
    return (result.affected ?? 0) > 0;
  }
}
