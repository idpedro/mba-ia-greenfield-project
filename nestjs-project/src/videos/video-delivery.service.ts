import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage';
import { Video } from './entities/video.entity';
import { PRESIGNED_URL_TTL_SECONDS } from './upload-limits';
import { VideoProcessingStatus } from './video.enums';
import { VideoNotReadyException } from './video.exceptions';
import { VideosService } from './videos.service';

/**
 * Builds an RFC 6266 `attachment` disposition for a file name: a quoted
 * ASCII fallback (`filename=`) for old clients plus the exact UTF-8 name
 * as an RFC 5987 `filename*=` extended value, which modern clients prefer.
 */
function buildAttachmentDisposition(filename: string): string {
  // Non-printable-ASCII chars, quotes and backslashes become "_" so the
  // quoted-string needs no escaping (clients disagree on backslash escapes).
  const asciiFallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  // encodeURIComponent leaves ' ( ) * unescaped, but RFC 5987 attr-char
  // does not allow them.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Hands out presigned storage URLs for the caller's ready videos, so the
 * video bytes go straight from the storage to the client, never through
 * the API.
 */
@Injectable()
export class VideoDeliveryService {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  /** Presigned GET of the original file on the public endpoint (1 hour). */
  async streamUrl(slug: string, userId: string): Promise<string> {
    const video = await this.findReadyOwned(slug, userId);
    return this.storageService.signGetUrl(video.original_key, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      client: 'public',
    });
  }

  /**
   * Same as {@link streamUrl}, but the storage answers with an `attachment`
   * Content-Disposition carrying the original file name, so the browser
   * saves the file instead of playing it.
   */
  async downloadUrl(slug: string, userId: string): Promise<string> {
    const video = await this.findReadyOwned(slug, userId);
    return this.storageService.signGetUrl(video.original_key, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      client: 'public',
      contentDisposition: buildAttachmentDisposition(video.original_filename),
    });
  }

  private async findReadyOwned(slug: string, userId: string): Promise<Video> {
    const video = await this.videosService.findOwnedBySlug(slug, userId);
    if (video.processing_status !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }
}
