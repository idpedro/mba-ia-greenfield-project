import type { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import {
  MultipartUploadNotFoundError,
  StorageModule,
  StorageService,
} from '../storage';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  buildTestStorageConfig,
  createTestS3Client,
  deleteTestBucket,
} from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../videos/video.enums';
import { StaleUploadSweepProcessor } from './stale-upload-sweep.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const VIDEO_MIME_TYPE = 'video/mp4';

/**
 * Real db and rustfs, throwaway bucket. The processor is a plain provider
 * here (no BullMQ root module), so no worker or scheduler is started and each
 * test runs exactly the sweeps it calls.
 */
describe('StaleUploadSweepProcessor (integration)', () => {
  const config = buildTestStorageConfig();
  let module: TestingModule;
  let processor: StaleUploadSweepProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let adminClient: S3Client;
  let channelId: string;

  /** Inserts a `pending_upload` draft with a real multipart upload. */
  const createVideo = async (
    ageHours: number,
    status = VideoProcessingStatus.PENDING_UPLOAD,
  ): Promise<Video> => {
    const id = randomUUID();
    const originalKey = `videos/${id}/original`;
    const uploadId = await storage.createMultipartUpload(
      originalKey,
      VIDEO_MIME_TYPE,
    );
    await videoRepository.insert({
      id,
      channel_id: channelId,
      slug: randomBytes(8).toString('base64url').slice(0, 11),
      title: 'sample',
      original_filename: 'sample.mp4',
      mime_type: VIDEO_MIME_TYPE,
      declared_size_bytes: 10_000_000,
      processing_status: status,
      upload_id: uploadId,
      original_key: originalKey,
    });
    await dataSource.query(
      `UPDATE videos SET created_at = now() - make_interval(hours => $1) WHERE id = $2`,
      [ageHours, id],
    );
    return videoRepository.findOneByOrFail({ id });
  };

  const reload = (video: Video): Promise<Video> =>
    videoRepository.findOneByOrFail({ id: video.id });

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        // The schema comes from the migrations, not a synchronized copy.
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [StaleUploadSweepProcessor],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .compile();

    // init() runs the bucket bootstrap on the throwaway bucket.
    await module.init();
    processor = module.get(StaleUploadSweepProcessor);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    adminClient = createTestS3Client(config);
  }, 30000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await module.close();
    await deleteTestBucket(adminClient, config.bucket);
    adminClient.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'stale_upload_sweep@example.com',
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'chan',
      nickname: 'stale_upload_sweep',
      user_id: user.id,
    });
    channelId = channel.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should expire only the pending upload older than 24 hours', async () => {
    const stale = await createVideo(25);
    const recent = await createVideo(1);
    const staleReady = await createVideo(25, VideoProcessingStatus.READY);

    const result = await processor.process();

    expect(result).toEqual({ expired: 1 });
    await expect(reload(stale)).resolves.toMatchObject({
      processing_status: VideoProcessingStatus.FAILED,
      failure_reason: VideoFailureReason.UPLOAD_EXPIRED,
      upload_id: null,
    });
    await expect(reload(recent)).resolves.toEqual(recent);
    await expect(reload(staleReady)).resolves.toEqual(staleReady);
  });

  it('should abort the multipart upload of the expired video only', async () => {
    const stale = await createVideo(25);
    const recent = await createVideo(1);

    await processor.process();

    await expect(
      storage.listParts(stale.original_key, stale.upload_id!),
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
    await expect(
      storage.listParts(recent.original_key, recent.upload_id!),
    ).resolves.toEqual([]);
  });

  it('should change no row when the sweep runs a second time', async () => {
    await createVideo(25);
    await createVideo(1);
    await processor.process();
    const before = await videoRepository.find({ order: { id: 'ASC' } });

    const result = await processor.process();

    expect(result).toEqual({ expired: 0 });
    await expect(
      videoRepository.find({ order: { id: 'ASC' } }),
    ).resolves.toEqual(before);
  });

  it('should still expire a video whose multipart upload no longer exists', async () => {
    const stale = await createVideo(25);
    await storage.abortMultipartUpload(stale.original_key, stale.upload_id!);

    const result = await processor.process();

    expect(result).toEqual({ expired: 1 });
    await expect(reload(stale)).resolves.toMatchObject({
      processing_status: VideoProcessingStatus.FAILED,
      failure_reason: VideoFailureReason.UPLOAD_EXPIRED,
      upload_id: null,
    });
  });

  it('should keep the video pending when the abort fails for another reason', async () => {
    const stale = await createVideo(25);
    jest
      .spyOn(storage, 'abortMultipartUpload')
      .mockRejectedValue(new Error('connect ECONNREFUSED rustfs:9000'));

    const result = await processor.process();

    expect(result).toEqual({ expired: 0 });
    await expect(reload(stale)).resolves.toEqual(stale);
  });

  it('should not overwrite a video that left pending_upload during the sweep', async () => {
    const stale = await createVideo(25);
    // A concurrent `complete` moves the row on while the abort is in flight.
    jest.spyOn(storage, 'abortMultipartUpload').mockImplementation(async () => {
      await videoRepository.update(
        { id: stale.id },
        { processing_status: VideoProcessingStatus.PROCESSING },
      );
    });

    const result = await processor.process();

    expect(result).toEqual({ expired: 0 });
    await expect(reload(stale)).resolves.toMatchObject({
      processing_status: VideoProcessingStatus.PROCESSING,
      failure_reason: null,
      upload_id: stale.upload_id,
    });
  });
});
