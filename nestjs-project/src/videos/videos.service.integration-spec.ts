import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './video-slug.util';
import { VideoNotFoundException } from './video.exceptions';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let service: VideosService;
  let userCounter = 0;

  const createUserWithChannel = async (): Promise<{
    user: User;
    channel: Channel;
  }> => {
    const n = ++userCounter;
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `chan${n}`,
      nickname: `videos_svc_${n}`,
      user_id: user.id,
    });
    return { user, channel };
  };

  const createVideo = async (channelId: string): Promise<Video> => {
    const id = randomUUID();
    return videoRepository.save({
      id,
      channel_id: channelId,
      slug: generateVideoSlug(),
      title: 'aula',
      original_filename: 'aula.mp4',
      mime_type: 'video/mp4',
      declared_size_bytes: 200_000_000,
      upload_id: 'upload-1',
      original_key: `videos/${id}/original`,
    });
  };

  beforeAll(async () => {
    // The schema comes from the migrations, not a synchronized copy.
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    service = new VideosService(videoRepository);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  describe('findOwnedById', () => {
    it("should return the video of the user's channel", async () => {
      const { user, channel } = await createUserWithChannel();
      const video = await createVideo(channel.id);

      const found = await service.findOwnedById(video.id, user.id);

      expect(found).toMatchObject({
        id: video.id,
        channel_id: channel.id,
        slug: video.slug,
        declared_size_bytes: 200_000_000,
        upload_id: 'upload-1',
      });
    });

    it("should throw not-found for another channel's video", async () => {
      const { channel } = await createUserWithChannel();
      const { user: otherUser } = await createUserWithChannel();
      const video = await createVideo(channel.id);

      await expect(
        service.findOwnedById(video.id, otherUser.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should throw not-found for a video that does not exist', async () => {
      const { user } = await createUserWithChannel();

      await expect(
        service.findOwnedById(randomUUID(), user.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('findOwnedBySlug', () => {
    it("should return the video of the user's channel", async () => {
      const { user, channel } = await createUserWithChannel();
      const video = await createVideo(channel.id);

      const found = await service.findOwnedBySlug(video.slug, user.id);

      expect(found.id).toBe(video.id);
    });

    it("should throw not-found for another channel's video", async () => {
      const { channel } = await createUserWithChannel();
      const { user: otherUser } = await createUserWithChannel();
      const video = await createVideo(channel.id);

      await expect(
        service.findOwnedBySlug(video.slug, otherUser.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should throw not-found for a slug that does not exist', async () => {
      const { user } = await createUserWithChannel();

      await expect(
        service.findOwnedBySlug('doesNotExst', user.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
