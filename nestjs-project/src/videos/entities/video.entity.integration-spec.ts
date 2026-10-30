import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generateVideoSlug } from '../video-slug.util';
import { VideoProcessingStatus, VideoPublicationStatus } from '../video.enums';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10737418240;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    // The schema comes from the migrations, so the test exercises the
    // migrated `videos` table (enum types, FK, cascade) rather than a
    // synchronized copy.
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video_chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      channel_id: channelId,
      slug: generateVideoSlug(),
      title: 'my-video',
      original_filename: 'my-video.mp4',
      mime_type: 'video/mp4',
      declared_size_bytes: 1024,
      original_key: 'videos/placeholder/original',
      ...overrides,
    });
  }

  it('should default processing_status to pending_upload and publication_status to draft', async () => {
    // Arrange
    const channel = await createChannel();

    // Act
    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    // Assert
    expect(found.processing_status).toBe(VideoProcessingStatus.PENDING_UPLOAD);
    expect(found.publication_status).toBe(VideoPublicationStatus.DRAFT);
    expect(found.failure_reason).toBeNull();
    expect(found.size_bytes).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should reject two videos with the same slug with a unique violation', async () => {
    // Arrange
    const channel = await createChannel();
    const slug = generateVideoSlug();
    await videoRepository.save(buildVideo(channel.id, { slug }));

    // Act
    const duplicate = videoRepository.save(buildVideo(channel.id, { slug }));

    // Assert
    await expect(duplicate).rejects.toBeInstanceOf(QueryFailedError);
    await expect(duplicate).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
  });

  it('should reject a video whose channel does not exist', async () => {
    // Act
    const orphan = videoRepository.save(
      buildVideo('00000000-0000-4000-8000-000000000000'),
    );

    // Assert
    await expect(orphan).rejects.toMatchObject({
      driverError: { code: '23503' },
    });
  });

  it('should delete the videos of a channel when the channel is deleted', async () => {
    // Arrange
    const channel = await createChannel();
    const otherChannel = await createChannel();
    await videoRepository.save(buildVideo(channel.id));
    await videoRepository.save(buildVideo(channel.id));
    const kept = await videoRepository.save(buildVideo(otherChannel.id));

    // Act
    await channelRepository.delete({ id: channel.id });

    // Assert
    expect(await videoRepository.countBy({ channel_id: channel.id })).toBe(0);
    expect(await videoRepository.findOneBy({ id: kept.id })).not.toBeNull();
  });

  it('should store and read back bigint and numeric columns as numbers', async () => {
    // Arrange
    const channel = await createChannel();

    // Act
    const saved = await videoRepository.save(
      buildVideo(channel.id, {
        declared_size_bytes: TEN_GIB,
        size_bytes: TEN_GIB,
        bitrate: 5_000_000,
        duration_seconds: 12.345,
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    // Assert
    expect(found.size_bytes).toBe(TEN_GIB);
    expect(found.declared_size_bytes).toBe(TEN_GIB);
    expect(found.bitrate).toBe(5_000_000);
    expect(found.duration_seconds).toBe(12.345);
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    // Arrange
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    // Act
    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });

    // Assert
    expect(found.channel.nickname).toBe(channel.nickname);
  });
});
