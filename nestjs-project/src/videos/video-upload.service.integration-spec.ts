import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule, StorageService } from '../storage';
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
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoUploadService } from './video-upload.service';
import { VideoProcessingStatus, VideoPublicationStatus } from './video.enums';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const DTO: CreateVideoDto = {
  filename: 'aula.mp4',
  mime_type: 'video/mp4',
  size_bytes: 200_000_000,
};

describe('VideoUploadService (integration)', () => {
  const config = buildTestStorageConfig();
  // A per-suite key prefix keeps test jobs away from the real queue keys.
  const queuePrefix = `test-${randomUUID()}`;
  let queue: Queue<ProcessVideoJobData>;
  let module: TestingModule;
  let service: VideoUploadService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let adminClient: S3Client;
  let userCounter = 0;

  const listOpenUploads = async (key: string): Promise<string[]> => {
    const output = await adminClient.send(
      new ListMultipartUploadsCommand({ Bucket: config.bucket, Prefix: key }),
    );
    return (output.Uploads ?? []).map((upload) => upload.UploadId ?? '');
  };

  const createUserWithChannel = async (): Promise<{
    user: User;
    channel: Channel;
  }> => {
    const n = ++userCounter;
    const user = await dataSource.getRepository(User).save({
      email: `video_upload_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `chan${n}`,
      nickname: `video_upload_${n}`,
      user_id: user.id,
    });
    return { user, channel };
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        // The schema comes from the migrations, not a synchronized copy.
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
        StorageModule,
        QueueModule,
        BullModule.registerQueue({
          name: VIDEO_PROCESSING_QUEUE,
          prefix: queuePrefix,
        }),
      ],
      providers: [VideoUploadService, VideosService],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .compile();

    // init() runs the bucket bootstrap, so the throwaway bucket exists.
    await module.init();
    service = module.get(VideoUploadService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    adminClient = createTestS3Client(config);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await deleteTestBucket(adminClient, config.bucket);
    adminClient.destroy();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should persist the draft in the user's channel with the multipart upload open in the storage", async () => {
    const { user, channel } = await createUserWithChannel();

    const { video } = await service.initiate(user.id, DTO);

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted).toMatchObject({
      channel_id: channel.id,
      title: 'aula',
      original_filename: 'aula.mp4',
      mime_type: 'video/mp4',
      declared_size_bytes: 200_000_000,
      processing_status: VideoProcessingStatus.PENDING_UPLOAD,
      publication_status: VideoPublicationStatus.DRAFT,
      original_key: `videos/${video.id}/original`,
    });
    expect(persisted.slug).toHaveLength(11);
    expect(persisted.upload_id).toBeTruthy();
    expect(await listOpenUploads(persisted.original_key)).toEqual([
      persisted.upload_id,
    ]);
  });

  it('should return the stored row, with unset metadata as null', async () => {
    const { user } = await createUserWithChannel();

    const { video } = await service.initiate(user.id, DTO);

    expect(video.created_at).toBeInstanceOf(Date);
    expect(video).toMatchObject({
      failure_reason: null,
      thumbnail_key: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      container_format: null,
      bitrate: null,
      size_bytes: null,
      processed_at: null,
    });
  });

  it('should abort the multipart upload when the row cannot be inserted', async () => {
    const { user } = await createUserWithChannel();
    const insertError = new Error('insert failed');
    jest.spyOn(videoRepository, 'insert').mockRejectedValueOnce(insertError);
    const createUpload = jest.spyOn(
      module.get(StorageService),
      'createMultipartUpload',
    );

    await expect(service.initiate(user.id, DTO)).rejects.toBe(insertError);

    const [key] = createUpload.mock.calls[0];
    expect(await listOpenUploads(key)).toEqual([]);
    expect(await videoRepository.count()).toBe(0);
  });

  describe('listUploadedParts', () => {
    const uploadPart = async (url: string, size: number): Promise<string> => {
      const response = await fetch(url, {
        method: 'PUT',
        body: Buffer.alloc(size, 7),
      });
      expect(response.status).toBe(200);
      return response.headers.get('etag') ?? '';
    };

    it('should return exactly the parts already sent, with their ETags', async () => {
      const { user } = await createUserWithChannel();
      const { video } = await service.initiate(user.id, DTO);
      const { parts: urls } = await service.signPartUrls(
        video.id,
        user.id,
        [1, 2],
      );
      const etag1 = await uploadPart(urls[0].url, 2048);
      const etag2 = await uploadPart(urls[1].url, 1024);

      const parts = await service.listUploadedParts(video.id, user.id);

      expect(etag1).toBeTruthy();
      expect(etag2).toBeTruthy();
      expect(parts).toEqual([
        { part_number: 1, etag: etag1, size_bytes: 2048 },
        { part_number: 2, etag: etag2, size_bytes: 1024 },
      ]);
    });

    it('should return an empty list when no part was sent yet', async () => {
      const { user } = await createUserWithChannel();
      const { video } = await service.initiate(user.id, DTO);

      await expect(
        service.listUploadedParts(video.id, user.id),
      ).resolves.toEqual([]);
    });
  });

  describe('complete', () => {
    const uploadPart = async (url: string, size: number): Promise<string> => {
      const response = await fetch(url, {
        method: 'PUT',
        body: Buffer.alloc(size, 3),
      });
      expect(response.status).toBe(200);
      return response.headers.get('etag') ?? '';
    };

    it('should store the object, move the row to processing and enqueue process-video', async () => {
      // A single part may be any size, so a small file keeps the test fast.
      const size = 4096;
      const { user } = await createUserWithChannel();
      const { video } = await service.initiate(user.id, {
        ...DTO,
        size_bytes: size,
      });
      const {
        parts: [url],
      } = await service.signPartUrls(video.id, user.id, [1]);
      const etag = await uploadPart(url.url, size);

      const completed = await service.complete(video.id, user.id, [
        { part_number: 1, etag },
      ]);

      const persisted = await videoRepository.findOneByOrFail({
        id: video.id,
      });
      expect(completed).toMatchObject({
        processing_status: VideoProcessingStatus.PROCESSING,
        size_bytes: size,
      });
      expect(persisted).toMatchObject({
        processing_status: VideoProcessingStatus.PROCESSING,
        size_bytes: size,
        upload_id: null,
      });
      expect(await listOpenUploads(persisted.original_key)).toEqual([]);
      await expect(
        module.get(StorageService).headObject(persisted.original_key),
      ).resolves.toMatchObject({ contentLength: size });

      const job = await queue.getJob(video.id);
      expect(job?.name).toBe(PROCESS_VIDEO_JOB);
      expect(job?.id).toBe(video.id);
      expect(job?.data).toEqual({ videoId: video.id });
    });
  });
});
