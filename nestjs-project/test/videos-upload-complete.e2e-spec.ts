import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import queueConfig from '../src/config/queue.config';
import { MailService } from '../src/mail/mail.service';
import { StorageObjectNotFoundError, StorageService } from '../src/storage';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing';
import { CreatedVideoResponseDto } from '../src/videos/dto/created-video-response.dto';
import { PartUrlsResponseDto } from '../src/videos/dto/part-urls-response.dto';
import { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { Video } from '../src/videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../src/videos/video.enums';

const PASSWORD = 'password123';
// A single part may be any size, so a small file keeps the upload fast.
const FILE_SIZE = 4096;
const WRONG_ETAG = '"00000000000000000000000000000000"';

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  // Queue on a per-suite key prefix: jobs never reach the dev queue that the
  // video-worker container consumes.
  let queue: Queue<ProcessVideoJobData>;
  let ownerToken: string;
  let userCounter = 0;

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _name: string, token: string) => {
          confirmationToken = token;
          return Promise.resolve();
        },
      );

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  const createVideo = async (sizeBytes: number): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: sizeBytes,
      })
      .expect(201);
    return (res.body as CreatedVideoResponseDto).id;
  };

  /** Sends the single part of the video with `size` bytes; returns its ETag. */
  const uploadSinglePart = async (
    id: string,
    size: number,
  ): Promise<string> => {
    const urls = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const [part] = (urls.body as PartUrlsResponseDto).parts;
    const response = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.alloc(size, 1),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag as string;
  };

  const completeUpload = (id: string, etag: string) =>
    request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: [{ part_number: 1, etag }] });

  const jobIdsFor = async (videoId: string): Promise<string[]> => {
    const jobs = await queue.getJobs();
    return jobs
      .filter((job) => job.data.videoId === videoId)
      .map((job) => job.id as string);
  };

  beforeAll(async () => {
    const { host, port } = queueConfig();
    queue = new Queue<ProcessVideoJobData>(VIDEO_PROCESSING_QUEUE, {
      connection: { host, port },
      prefix: `test-${randomUUID()}`,
    });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue(queue)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storage = app.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    const n = ++userCounter;
    ownerToken = await registerConfirmAndLogin(
      `upload_complete_owner_${n}@example.com`,
    );
  });

  afterEach(async () => {
    // Clean the dev bucket: abort open uploads and delete completed objects.
    const open = await videoRepository.findBy({ upload_id: Not(IsNull()) });
    for (const video of open) {
      await storage.abortMultipartUpload(
        video.original_key,
        video.upload_id as string,
      );
    }
    for (const video of await videoRepository.find()) {
      await storage.deleteObject(video.original_key);
    }
    jest.restoreAllMocks();
  });

  // 1. POST /videos/:id/upload/complete

  it('conclui-upload-e-enfileira-process-video', async () => {
    const videoId = await createVideo(FILE_SIZE);
    const etag = await uploadSinglePart(videoId, FILE_SIZE);

    const res = await completeUpload(videoId, etag).expect(200);

    const body = res.body as VideoResponseDto;
    expect(body.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    expect(body.size_bytes).toBe(FILE_SIZE);
    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.id).toBe(videoId);
    expect(job?.data).toEqual({ videoId });
  });

  it('complete-repetido-retorna-conflito-sem-segundo-job', async () => {
    const videoId = await createVideo(FILE_SIZE);
    const etag = await uploadSinglePart(videoId, FILE_SIZE);
    await completeUpload(videoId, etag).expect(200);

    const res = await completeUpload(videoId, etag).expect(409);

    expect((res.body as ApiErrorEnvelope).error).toBe(
      'VIDEO_UPLOAD_NOT_PENDING',
    );
    expect(await jobIdsFor(videoId)).toEqual([videoId]);
  });

  it('etag-errado-mantem-pending-upload-e-aceita-retry', async () => {
    const videoId = await createVideo(FILE_SIZE);
    const etag = await uploadSinglePart(videoId, FILE_SIZE);

    const rejected = await completeUpload(videoId, WRONG_ETAG).expect(400);

    expect((rejected.body as ApiErrorEnvelope).error).toBe('UPLOAD_INCOMPLETE');
    const row = await videoRepository.findOneByOrFail({ id: videoId });
    expect(row.processing_status).toBe(VideoProcessingStatus.PENDING_UPLOAD);
    expect(row.upload_id).toBeTruthy();
    expect(await jobIdsFor(videoId)).toEqual([]);

    const retried = await completeUpload(videoId, etag).expect(200);

    expect((retried.body as VideoResponseDto).processing_status).toBe(
      VideoProcessingStatus.PROCESSING,
    );
  });

  it('tamanho-divergente-falha-e-apaga-objeto', async () => {
    // Declares more bytes than are sent; both sizes fit in one part.
    const videoId = await createVideo(FILE_SIZE * 2);
    const etag = await uploadSinglePart(videoId, FILE_SIZE);

    const res = await completeUpload(videoId, etag).expect(422);

    expect((res.body as ApiErrorEnvelope).error).toBe('UPLOAD_SIZE_MISMATCH');
    const row = await videoRepository.findOneByOrFail({ id: videoId });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.failure_reason).toBe(VideoFailureReason.SIZE_MISMATCH);
    expect(row.upload_id).toBeNull();
    await expect(
      storage.headObject(`videos/${videoId}/original`),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    expect(await jobIdsFor(videoId)).toEqual([]);
  });
});
