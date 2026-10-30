import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { CreatedVideoResponseDto } from '../src/videos/dto/created-video-response.dto';
import { PartUrlsResponseDto } from '../src/videos/dto/part-urls-response.dto';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingStatus } from '../src/videos/video.enums';

const PASSWORD = 'password123';
const ONE_HOUR_MS = 60 * 60 * 1000;
const EXPIRY_TOLERANCE_MS = 10_000;
// 200 MB at 64 MiB per part: a 3-part video.
const CREATE_BODY = {
  filename: 'aula.mp4',
  mime_type: 'video/mp4',
  size_bytes: 200000000,
};

describe('videos-upload-part-urls', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
  let videoId: string;
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

  const requestPartUrls = (id: string, token: string, partNumbers: number[]) =>
    request(app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const n = ++userCounter;
    ownerToken = await registerConfirmAndLogin(
      `part_urls_owner_${n}@example.com`,
    );
    otherToken = await registerConfirmAndLogin(
      `part_urls_other_${n}@example.com`,
    );

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(CREATE_BODY)
      .expect(201);
    videoId = (res.body as CreatedVideoResponseDto).id;
  });

  afterEach(async () => {
    // Abort the multipart uploads opened in the dev bucket by the test.
    const storage = app.get(StorageService);
    const open = await videoRepository.findBy({ upload_id: Not(IsNull()) });
    for (const video of open) {
      await storage.abortMultipartUpload(
        video.original_key,
        video.upload_id as string,
      );
    }
    jest.restoreAllMocks();
  });

  // 1. POST /videos/:id/upload/part-urls

  it('assina-urls-de-parte-no-host-publico', async () => {
    const requestedAt = Date.now();
    const res = await requestPartUrls(videoId, ownerToken, [1, 2]).expect(200);
    const body = res.body as PartUrlsResponseDto;

    expect(body.parts.map((part) => part.part_number)).toEqual([1, 2]);
    const publicHost = new URL(process.env.S3_PUBLIC_ENDPOINT as string).host;
    for (const part of body.parts) {
      expect(new URL(part.url).host).toBe(publicHost);
    }
    const expiresAt = new Date(body.expires_at).getTime();
    expect(Math.abs(expiresAt - (requestedAt + ONE_HOUR_MS))).toBeLessThan(
      EXPIRY_TOLERANCE_MS,
    );

    const upload = await fetch(body.parts[0].url, {
      method: 'PUT',
      body: Buffer.alloc(1024, 1),
    });
    expect(upload.status).toBe(200);
    expect(upload.headers.get('etag')).toBeTruthy();
  });

  it('rejeita-part-number-fora-do-intervalo', async () => {
    const res = await requestPartUrls(videoId, ownerToken, [999]).expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('INVALID_PART_NUMBER');
  });

  it('outro-usuario-recebe-not-found', async () => {
    const res = await requestPartUrls(videoId, otherToken, [1]).expect(404);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });

  it('rejeita-video-fora-de-pending-upload', async () => {
    await videoRepository.update(
      { id: videoId },
      { processing_status: VideoProcessingStatus.PROCESSING },
    );

    const res = await requestPartUrls(videoId, ownerToken, [1]).expect(409);

    expect((res.body as ApiErrorEnvelope).error).toBe(
      'VIDEO_UPLOAD_NOT_PENDING',
    );
  });

  it('rejeita-id-que-nao-e-uuid', async () => {
    await requestPartUrls('nao-e-uuid', ownerToken, [1]).expect(400);
  });
});
