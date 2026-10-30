import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadPartsError,
  MultipartUploadNotFoundError,
  StorageService,
} from '../storage';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing';
import type { CompletedPartDto } from './dto/completed-part.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  calculatePartCount,
  MAX_VIDEO_SIZE_BYTES,
  PRESIGNED_URL_TTL_SECONDS,
  UPLOAD_PART_SIZE_BYTES,
} from './upload-limits';
import { generateVideoSlug } from './video-slug.util';
import {
  VideoFailureReason,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './video.enums';
import {
  InvalidPartNumberException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoUploadNotPendingException,
} from './video.exceptions';
import { VideosService } from './videos.service';

const PG_UNIQUE_VIOLATION = '23505';
const MAX_SLUG_ATTEMPTS = 5;
const TITLE_MAX_LENGTH = 100;

export interface UploadPlan {
  part_size_bytes: number;
  part_count: number;
}

export interface InitiatedUpload {
  video: Video;
  upload: UploadPlan;
}

export interface SignedPartUrl {
  part_number: number;
  url: string;
}

export interface SignedPartUrls {
  parts: SignedPartUrl[];
  expires_at: Date;
}

export interface UploadedPartSummary {
  part_number: number;
  etag: string;
  size_bytes: number;
}

const buildOriginalKey = (videoId: string): string =>
  `videos/${videoId}/original`;

/** `aula.mp4` → `aula`; a leading dot (`.mp4`) is not treated as extension. */
const titleFromFilename = (filename: string): string => {
  const extensionStart = filename.lastIndexOf('.');
  const base =
    extensionStart > 0 ? filename.slice(0, extensionStart) : filename;
  return base.slice(0, TITLE_MAX_LENGTH);
};

const isSlugUniqueViolation = (error: unknown): boolean => {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error.driverError as {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes('(slug)')
  );
};

@Injectable()
export class VideoUploadService {
  private readonly logger = new Logger(VideoUploadService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videosService: VideosService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Creates the draft video in the caller's channel and opens the multipart
   * upload of its original file. If the row cannot be inserted, the
   * multipart upload is aborted so no orphan upload is left in the storage.
   */
  async initiate(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiatedUpload> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every user gets a channel at registration; a missing one is a bug.
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const originalKey = buildOriginalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      originalKey,
      dto.mime_type,
    );

    try {
      await this.insertWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: dto.title ?? titleFromFilename(dto.filename),
        original_filename: dto.filename,
        mime_type: dto.mime_type,
        declared_size_bytes: dto.size_bytes,
        processing_status: VideoProcessingStatus.PENDING_UPLOAD,
        publication_status: VideoPublicationStatus.DRAFT,
        upload_id: uploadId,
        original_key: originalKey,
      });
    } catch (error) {
      await this.abortUpload(originalKey, uploadId);
      throw error;
    }

    // Reload so every nullable column comes back as `null` (an insert only
    // returns the database-generated ones).
    const video = await this.videoRepository.findOneByOrFail({ id });

    return {
      video,
      upload: {
        part_size_bytes: UPLOAD_PART_SIZE_BYTES,
        part_count: calculatePartCount(dto.size_bytes),
      },
    };
  }

  /**
   * Signs, on the public storage client, the `UploadPart` URLs for the given
   * parts of the caller's pending upload. Called at start and again on
   * resume, since the URLs expire.
   */
  async signPartUrls(
    id: string,
    userId: string,
    partNumbers: number[],
  ): Promise<SignedPartUrls> {
    const video = await this.videosService.findOwnedById(id, userId);
    const uploadId = this.requirePendingUploadId(video);

    const partCount = calculatePartCount(video.declared_size_bytes);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumberException();
    }

    // Taken before signing, so the reported expiry is never later than the
    // real one.
    const expiresAt = new Date(Date.now() + PRESIGNED_URL_TTL_SECONDS * 1000);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.signUploadPartUrl(
          video.original_key,
          uploadId,
          partNumber,
          PRESIGNED_URL_TTL_SECONDS,
        ),
      })),
    );

    return { parts, expires_at: expiresAt };
  }

  /**
   * Lists the parts already stored in the caller's pending multipart upload,
   * ordered by part number, so an interrupted upload can be resumed by
   * sending only the missing parts.
   */
  async listUploadedParts(
    id: string,
    userId: string,
  ): Promise<UploadedPartSummary[]> {
    const video = await this.videosService.findOwnedById(id, userId);
    const uploadId = this.requirePendingUploadId(video);

    // The storage pages through ListParts to the end and sorts by number.
    const parts = await this.storageService.listParts(
      video.original_key,
      uploadId,
    );
    return parts.map((part) => ({
      part_number: part.partNumber,
      etag: part.etag,
      size_bytes: part.size,
    }));
  }

  /**
   * Completes the caller's multipart upload, checks the stored size and moves
   * the video to `processing`. The `process-video` job is published only
   * after that change commits, so the worker never sees a pending row.
   */
  async complete(
    id: string,
    userId: string,
    parts: CompletedPartDto[],
  ): Promise<Video> {
    const video = await this.videosService.findOwnedById(id, userId);
    const uploadId = this.requirePendingUploadId(video);

    try {
      await this.storageService.completeMultipartUpload(
        video.original_key,
        uploadId,
        parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      // The row is left untouched: the multipart stays open for a retry.
      if (
        error instanceof InvalidUploadPartsError ||
        error instanceof MultipartUploadNotFoundError
      ) {
        throw new UploadIncompleteException();
      }
      throw error;
    }

    const { contentLength } = await this.storageService.headObject(
      video.original_key,
    );
    if (
      contentLength !== video.declared_size_bytes ||
      contentLength > MAX_VIDEO_SIZE_BYTES
    ) {
      await this.rejectSizeMismatch(video);
    }

    await this.videoRepository.manager.transaction(async (manager) => {
      // Guarded by status: of two concurrent completes only one moves the row.
      const result = await manager.update(
        Video,
        { id, processing_status: VideoProcessingStatus.PENDING_UPLOAD },
        {
          size_bytes: contentLength,
          upload_id: null,
          processing_status: VideoProcessingStatus.PROCESSING,
        },
      );
      if (result.affected !== 1) {
        throw new VideoUploadNotPendingException();
      }
    });

    // `jobId = videoId` makes a duplicate enqueue a no-op.
    await this.videoProcessingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: id },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: id },
    );

    return this.videoRepository.findOneByOrFail({ id });
  }

  /**
   * Deletes the stored object whose size differs from the declared one and
   * marks the video as failed, then throws `UploadSizeMismatchException`.
   */
  private async rejectSizeMismatch(video: Video): Promise<never> {
    await this.storageService.deleteObject(video.original_key);
    await this.videoRepository.update(
      {
        id: video.id,
        processing_status: VideoProcessingStatus.PENDING_UPLOAD,
      },
      {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.SIZE_MISMATCH,
        upload_id: null,
      },
    );
    throw new UploadSizeMismatchException();
  }

  /** Returns the open multipart `UploadId` of a video awaiting its upload. */
  private requirePendingUploadId(video: Video): string {
    if (video.processing_status !== VideoProcessingStatus.PENDING_UPLOAD) {
      throw new VideoUploadNotPendingException();
    }
    if (!video.upload_id) {
      // A pending upload always keeps its UploadId; a missing one is a bug.
      throw new Error(`Pending video ${video.id} has no upload_id`);
    }
    return video.upload_id;
  }

  private async insertWithUniqueSlug(
    fields: Omit<Partial<Video>, 'slug'>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const video = this.videoRepository.create({
        ...fields,
        slug: generateVideoSlug(),
      });
      try {
        await this.videoRepository.insert(video);
        return;
      } catch (error) {
        if (!isSlugUniqueViolation(error)) {
          throw error;
        }
      }
    }
    throw new Error(
      `Could not generate a unique video slug after ${MAX_SLUG_ATTEMPTS} attempts`,
    );
  }

  private async abortUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(key, uploadId);
    } catch (abortError) {
      // The insert error is the one rethrown to the caller; the orphan upload
      // is still reclaimed by the bucket's multipart lifecycle.
      this.logger.error(
        `Failed to abort multipart upload ${uploadId} for ${key}`,
        abortError instanceof Error ? abortError.stack : String(abortError),
      );
    }
  }
}
