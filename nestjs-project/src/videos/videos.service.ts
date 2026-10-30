import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from './entities/video.entity';
import { VideoNotFoundException } from './video.exceptions';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  /**
   * Returns the video when it belongs to the channel of `userId`. A video of
   * another channel is reported exactly like a missing one, so the existence
   * of other users' drafts is not revealed.
   */
  async findOwnedById(id: string, userId: string): Promise<Video> {
    return this.findOwned('video.id = :id', { id }, userId);
  }

  /** Same ownership rule as `findOwnedById`, addressing the video by slug. */
  async findOwnedBySlug(slug: string, userId: string): Promise<Video> {
    return this.findOwned('video.slug = :slug', { slug }, userId);
  }

  private async findOwned(
    condition: string,
    parameters: Record<string, string>,
    userId: string,
  ): Promise<Video> {
    const video = await this.videoRepository
      .createQueryBuilder('video')
      .innerJoin('video.channel', 'channel', 'channel.user_id = :userId', {
        userId,
      })
      .where(condition, parameters)
      .getOne();
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }
}
