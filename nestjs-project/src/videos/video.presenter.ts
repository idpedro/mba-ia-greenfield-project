import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage';
import type { VideoResponseDto } from './dto/video-response.dto';
import type { Video } from './entities/video.entity';
import { PRESIGNED_URL_TTL_SECONDS } from './upload-limits';

/** Maps a `Video` row to the public `VideoResponse` shape. */
@Injectable()
export class VideoPresenter {
  constructor(private readonly storageService: StorageService) {}

  async toResponse(video: Video): Promise<VideoResponseDto> {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      original_filename: video.original_filename,
      mime_type: video.mime_type,
      processing_status: video.processing_status,
      publication_status: video.publication_status,
      failure_reason: video.failure_reason,
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      audio_codec: video.audio_codec,
      container_format: video.container_format,
      bitrate: video.bitrate,
      size_bytes: video.size_bytes,
      thumbnail_url: await this.signThumbnailUrl(video.thumbnail_key),
      created_at: video.created_at.toISOString(),
      processed_at: video.processed_at?.toISOString() ?? null,
    };
  }

  private async signThumbnailUrl(
    thumbnailKey: string | null,
  ): Promise<string | null> {
    if (!thumbnailKey) {
      return null;
    }
    return this.storageService.signGetUrl(thumbnailKey, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      client: 'public',
    });
  }
}
