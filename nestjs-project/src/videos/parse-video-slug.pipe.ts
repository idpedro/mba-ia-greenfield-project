import { Injectable, PipeTransform } from '@nestjs/common';
import { VideoNotFoundException } from './video.exceptions';
import { isVideoSlug } from './video-slug.util';

/**
 * Rejects a `:slug` route param that cannot be a video slug before any query
 * runs. A malformed slug is reported as `VIDEO_NOT_FOUND`, like a missing one.
 */
@Injectable()
export class ParseVideoSlugPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isVideoSlug(value)) {
      throw new VideoNotFoundException();
    }
    return value;
  }
}
