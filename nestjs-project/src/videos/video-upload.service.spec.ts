import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadPartsError,
  MultipartUploadNotFoundError,
  StorageService,
} from '../storage';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  MAX_VIDEO_SIZE_BYTES,
  PRESIGNED_URL_TTL_SECONDS,
  UPLOAD_PART_SIZE_BYTES,
} from './upload-limits';
import { VideoUploadService } from './video-upload.service';
import { VideoFailureReason, VideoProcessingStatus } from './video.enums';
import {
  InvalidPartNumberException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoUploadNotPendingException,
} from './video.exceptions';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const UPLOAD_ID = 'upload-1';

const uniqueViolation = (column: string): QueryFailedError =>
  new QueryFailedError('INSERT INTO "videos" ...', [], {
    code: '23505',
    detail: `Key (${column})=(abc) already exists.`,
  } as unknown as Error);

const VIDEO_ID = '0b9e7c1e-5f0a-4d55-9a57-3f1f4c1d2e3a';

const buildPendingVideo = (overrides: Partial<Video> = {}): Video =>
  ({
    id: VIDEO_ID,
    channel_id: CHANNEL_ID,
    processing_status: VideoProcessingStatus.PENDING_UPLOAD,
    declared_size_bytes: 200_000_000, // 3 parts of 64 MiB
    upload_id: UPLOAD_ID,
    original_key: `videos/${VIDEO_ID}/original`,
    ...overrides,
  }) as Video;

const buildDto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto => ({
  filename: 'aula.mp4',
  mime_type: 'video/mp4',
  size_bytes: 200_000_000,
  ...overrides,
});

describe('VideoUploadService', () => {
  let service: VideoUploadService;
  const videoRepository = {
    create: jest.fn((fields: Partial<Video>) => ({ ...fields }) as Video),
    insert: jest.fn<Promise<unknown>, [Video]>(),
    findOneByOrFail: jest.fn(),
    update: jest.fn(),
    manager: { transaction: jest.fn() },
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    signUploadPartUrl: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const videosService = { findOwnedById: jest.fn() };
  const videoProcessingQueue = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsService.findByUserId.mockResolvedValue({ id: CHANNEL_ID });
    storageService.createMultipartUpload.mockResolvedValue(UPLOAD_ID);
    storageService.abortMultipartUpload.mockResolvedValue(undefined);
    videoRepository.insert.mockResolvedValue({});
    // Echo back the last inserted row, as the reload after insert would.
    videoRepository.findOneByOrFail.mockImplementation(() =>
      Promise.resolve(videoRepository.insert.mock.lastCall?.[0]),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideoUploadService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideosService, useValue: videosService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: videoProcessingQueue,
        },
      ],
    }).compile();

    service = module.get(VideoUploadService);
  });

  const insertedSlugs = (): string[] =>
    videoRepository.insert.mock.calls.map(([video]) => video.slug);

  it("should open the multipart upload under the video's id and store it on the row", async () => {
    const { video } = await service.initiate(USER_ID, buildDto());

    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      `videos/${video.id}/original`,
      'video/mp4',
    );
    expect(video).toMatchObject({
      channel_id: CHANNEL_ID,
      upload_id: UPLOAD_ID,
      original_key: `videos/${video.id}/original`,
      declared_size_bytes: 200_000_000,
      original_filename: 'aula.mp4',
    });
  });

  it('should default the title to the file name without its extension', async () => {
    const { video } = await service.initiate(
      USER_ID,
      buildDto({ filename: 'aula.final.mp4' }),
    );

    expect(video.title).toBe('aula.final');
  });

  it('should keep a file name without extension as the title', async () => {
    const { video } = await service.initiate(
      USER_ID,
      buildDto({ filename: 'aula' }),
    );

    expect(video.title).toBe('aula');
  });

  it('should truncate the default title to 100 characters', async () => {
    const { video } = await service.initiate(
      USER_ID,
      buildDto({ filename: `${'a'.repeat(150)}.mp4` }),
    );

    expect(video.title).toBe('a'.repeat(100));
  });

  it('should use the given title instead of the file name', async () => {
    const { video } = await service.initiate(
      USER_ID,
      buildDto({ title: 'Minha aula' }),
    );

    expect(video.title).toBe('Minha aula');
  });

  it('should return the upload plan with ceil(size / part size) parts', async () => {
    const { upload } = await service.initiate(
      USER_ID,
      buildDto({ size_bytes: UPLOAD_PART_SIZE_BYTES * 2 + 1 }),
    );

    expect(upload).toEqual({
      part_size_bytes: UPLOAD_PART_SIZE_BYTES,
      part_count: 3,
    });
  });

  it('should retry with a new slug when the slug is already taken', async () => {
    videoRepository.insert
      .mockRejectedValueOnce(uniqueViolation('slug'))
      .mockResolvedValueOnce({});

    const { video } = await service.initiate(USER_ID, buildDto());

    const slugs = insertedSlugs();
    expect(slugs).toHaveLength(2);
    expect(slugs[0]).not.toBe(slugs[1]);
    expect(video.slug).toBe(slugs[1]);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('should abort the multipart upload after 5 slug collisions', async () => {
    videoRepository.insert.mockRejectedValue(uniqueViolation('slug'));

    await expect(service.initiate(USER_ID, buildDto())).rejects.toThrow(
      /unique video slug/,
    );

    expect(videoRepository.insert).toHaveBeenCalledTimes(5);
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^videos\/.+\/original$/),
      UPLOAD_ID,
    );
  });

  it('should abort the multipart upload and rethrow when the insert fails', async () => {
    const insertError = uniqueViolation('id');
    videoRepository.insert.mockRejectedValue(insertError);

    await expect(service.initiate(USER_ID, buildDto())).rejects.toBe(
      insertError,
    );

    expect(videoRepository.insert).toHaveBeenCalledTimes(1);
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^videos\/.+\/original$/),
      UPLOAD_ID,
    );
  });

  it('should rethrow the insert error even when the abort also fails', async () => {
    const insertError = new Error('connection lost');
    videoRepository.insert.mockRejectedValue(insertError);
    storageService.abortMultipartUpload.mockRejectedValue(
      new Error('storage down'),
    );
    const logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(service.initiate(USER_ID, buildDto())).rejects.toBe(
      insertError,
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(UPLOAD_ID),
      expect.any(String),
    );
    logError.mockRestore();
  });

  it('should not open a multipart upload when the user has no channel', async () => {
    channelsService.findByUserId.mockResolvedValue(null);

    await expect(service.initiate(USER_ID, buildDto())).rejects.toThrow(
      /has no channel/,
    );

    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  describe('signPartUrls', () => {
    beforeEach(() => {
      videosService.findOwnedById.mockResolvedValue(buildPendingVideo());
      storageService.signUploadPartUrl.mockImplementation(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage.test/part-${partNumber}`),
      );
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should sign each requested part of the video's multipart upload", async () => {
      const result = await service.signPartUrls(VIDEO_ID, USER_ID, [1, 3]);

      expect(videosService.findOwnedById).toHaveBeenCalledWith(
        VIDEO_ID,
        USER_ID,
      );
      expect(result.parts).toEqual([
        { part_number: 1, url: 'https://storage.test/part-1' },
        { part_number: 3, url: 'https://storage.test/part-3' },
      ]);
      expect(storageService.signUploadPartUrl).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/original`,
        UPLOAD_ID,
        1,
        PRESIGNED_URL_TTL_SECONDS,
      );
      expect(storageService.signUploadPartUrl).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/original`,
        UPLOAD_ID,
        3,
        PRESIGNED_URL_TTL_SECONDS,
      );
    });

    it('should report expires_at as now + 1 hour', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-30T12:00:00.000Z') });

      const { expires_at } = await service.signPartUrls(VIDEO_ID, USER_ID, [1]);

      expect(expires_at).toEqual(new Date('2026-10-30T13:00:00.000Z'));
    });

    it.each([
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
    ])(
      'should reject a video in %s without signing anything',
      async (status) => {
        videosService.findOwnedById.mockResolvedValue(
          buildPendingVideo({ processing_status: status, upload_id: null }),
        );

        await expect(
          service.signPartUrls(VIDEO_ID, USER_ID, [1]),
        ).rejects.toBeInstanceOf(VideoUploadNotPendingException);
        expect(storageService.signUploadPartUrl).not.toHaveBeenCalled();
      },
    );

    it('should reject a part number above the part count', async () => {
      await expect(
        service.signPartUrls(VIDEO_ID, USER_ID, [1, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.signUploadPartUrl).not.toHaveBeenCalled();
    });

    it('should accept the last part number', async () => {
      const { parts } = await service.signPartUrls(VIDEO_ID, USER_ID, [3]);

      expect(parts).toEqual([
        { part_number: 3, url: 'https://storage.test/part-3' },
      ]);
    });

    it('should propagate the not-found error of a video the user does not own', async () => {
      videosService.findOwnedById.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service.signPartUrls(VIDEO_ID, USER_ID, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storageService.signUploadPartUrl).not.toHaveBeenCalled();
    });
  });

  describe('listUploadedParts', () => {
    beforeEach(() => {
      videosService.findOwnedById.mockResolvedValue(buildPendingVideo());
    });

    it("should list the parts of the video's multipart upload in the response shape", async () => {
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"etag-1"', size: 67108864 },
        { partNumber: 2, etag: '"etag-2"', size: 1024 },
      ]);

      const parts = await service.listUploadedParts(VIDEO_ID, USER_ID);

      expect(videosService.findOwnedById).toHaveBeenCalledWith(
        VIDEO_ID,
        USER_ID,
      );
      expect(storageService.listParts).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/original`,
        UPLOAD_ID,
      );
      expect(parts).toEqual([
        { part_number: 1, etag: '"etag-1"', size_bytes: 67108864 },
        { part_number: 2, etag: '"etag-2"', size_bytes: 1024 },
      ]);
    });

    it.each([
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
    ])(
      'should reject a video in %s without querying the storage',
      async (status) => {
        videosService.findOwnedById.mockResolvedValue(
          buildPendingVideo({ processing_status: status, upload_id: null }),
        );

        await expect(
          service.listUploadedParts(VIDEO_ID, USER_ID),
        ).rejects.toBeInstanceOf(VideoUploadNotPendingException);
        expect(storageService.listParts).not.toHaveBeenCalled();
      },
    );

    it('should propagate the not-found error of a video the user does not own', async () => {
      videosService.findOwnedById.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service.listUploadedParts(VIDEO_ID, USER_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storageService.listParts).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    const DECLARED_SIZE = 200_000_000;
    const PARTS = [
      { part_number: 1, etag: '"etag-1"' },
      { part_number: 2, etag: '"etag-2"' },
    ];
    // Order in which the collaborators run, to assert commit before enqueue.
    let calls: string[];
    const manager = { update: jest.fn() };

    beforeEach(() => {
      calls = [];
      videosService.findOwnedById.mockResolvedValue(buildPendingVideo());
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.headObject.mockResolvedValue({
        contentLength: DECLARED_SIZE,
      });
      storageService.deleteObject.mockResolvedValue(undefined);
      videoRepository.update.mockResolvedValue({ affected: 1 });
      manager.update.mockImplementation(() => {
        calls.push('update');
        return Promise.resolve({ affected: 1 });
      });
      videoRepository.manager.transaction.mockImplementation(
        async (work: (m: typeof manager) => Promise<void>) => {
          await work(manager);
          calls.push('commit');
        },
      );
      videoProcessingQueue.add.mockImplementation(() => {
        calls.push('enqueue');
        return Promise.resolve({});
      });
      videoRepository.findOneByOrFail.mockResolvedValue(
        buildPendingVideo({
          processing_status: VideoProcessingStatus.PROCESSING,
          size_bytes: DECLARED_SIZE,
          upload_id: null,
        }),
      );
    });

    it('should complete the multipart upload with the given parts', async () => {
      await service.complete(VIDEO_ID, USER_ID, PARTS);

      expect(videosService.findOwnedById).toHaveBeenCalledWith(
        VIDEO_ID,
        USER_ID,
      );
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/original`,
        UPLOAD_ID,
        [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      );
    });

    it('should move only a pending row to processing with the stored size', async () => {
      await service.complete(VIDEO_ID, USER_ID, PARTS);

      expect(manager.update).toHaveBeenCalledWith(
        Video,
        {
          id: VIDEO_ID,
          processing_status: VideoProcessingStatus.PENDING_UPLOAD,
        },
        {
          size_bytes: DECLARED_SIZE,
          upload_id: null,
          processing_status: VideoProcessingStatus.PROCESSING,
        },
      );
    });

    it('should enqueue process-video with jobId = videoId only after the commit', async () => {
      const video = await service.complete(VIDEO_ID, USER_ID, PARTS);

      expect(calls).toEqual(['update', 'commit', 'enqueue']);
      expect(videoProcessingQueue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        { videoId: VIDEO_ID },
        { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: VIDEO_ID },
      );
      expect(video.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    });

    it('should reject with not-pending and not enqueue when another complete moved the row first', async () => {
      manager.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.complete(VIDEO_ID, USER_ID, PARTS),
      ).rejects.toBeInstanceOf(VideoUploadNotPendingException);
      expect(videoProcessingQueue.add).not.toHaveBeenCalled();
    });

    it.each([
      ['an invalid part', new InvalidUploadPartsError('key', 'InvalidPart')],
      ['a missing upload', new MultipartUploadNotFoundError('key', UPLOAD_ID)],
    ])(
      'should translate %s into UploadIncompleteException without touching the row',
      async (_case, storageError) => {
        storageService.completeMultipartUpload.mockRejectedValue(storageError);

        await expect(
          service.complete(VIDEO_ID, USER_ID, PARTS),
        ).rejects.toBeInstanceOf(UploadIncompleteException);
        expect(storageService.headObject).not.toHaveBeenCalled();
        expect(videoRepository.update).not.toHaveBeenCalled();
        expect(videoRepository.manager.transaction).not.toHaveBeenCalled();
        expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
        expect(videoProcessingQueue.add).not.toHaveBeenCalled();
      },
    );

    it('should propagate an unexpected storage error as is', async () => {
      const storageError = new Error('storage down');
      storageService.completeMultipartUpload.mockRejectedValue(storageError);

      await expect(service.complete(VIDEO_ID, USER_ID, PARTS)).rejects.toBe(
        storageError,
      );
    });

    it.each([
      ['smaller than', DECLARED_SIZE - 1, DECLARED_SIZE],
      ['larger than', DECLARED_SIZE + 1, DECLARED_SIZE],
      [
        'above 10 GiB even if equal to',
        MAX_VIDEO_SIZE_BYTES + 1,
        MAX_VIDEO_SIZE_BYTES + 1,
      ],
    ])(
      'should delete the object and fail the video when the stored size is %s the declared one',
      async (_case, storedSize, declaredSize) => {
        videosService.findOwnedById.mockResolvedValue(
          buildPendingVideo({ declared_size_bytes: declaredSize }),
        );
        storageService.headObject.mockResolvedValue({
          contentLength: storedSize,
        });

        await expect(
          service.complete(VIDEO_ID, USER_ID, PARTS),
        ).rejects.toBeInstanceOf(UploadSizeMismatchException);
        expect(storageService.deleteObject).toHaveBeenCalledWith(
          `videos/${VIDEO_ID}/original`,
        );
        expect(videoRepository.update).toHaveBeenCalledWith(
          {
            id: VIDEO_ID,
            processing_status: VideoProcessingStatus.PENDING_UPLOAD,
          },
          {
            processing_status: VideoProcessingStatus.FAILED,
            failure_reason: VideoFailureReason.SIZE_MISMATCH,
            upload_id: null,
          },
        );
        expect(videoRepository.manager.transaction).not.toHaveBeenCalled();
        expect(videoProcessingQueue.add).not.toHaveBeenCalled();
      },
    );

    it.each([
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
    ])(
      'should reject a video in %s without touching the storage',
      async (status) => {
        videosService.findOwnedById.mockResolvedValue(
          buildPendingVideo({ processing_status: status, upload_id: null }),
        );

        await expect(
          service.complete(VIDEO_ID, USER_ID, PARTS),
        ).rejects.toBeInstanceOf(VideoUploadNotPendingException);
        expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
        expect(videoProcessingQueue.add).not.toHaveBeenCalled();
      },
    );

    it('should propagate the not-found error of a video the user does not own', async () => {
      videosService.findOwnedById.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service.complete(VIDEO_ID, USER_ID, PARTS),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
