import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import storageConfig from '../src/config/storage.config';
import { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { createMediaFixtures } from '../src/test/video-fixture';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingStatus } from '../src/videos/video.enums';
import { generateVideoSlug } from '../src/videos/video-slug.util';

const PASSWORD = 'password123';

describe('videos-stream', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let publicEndpoint: string;
  let videoBytes: Buffer;
  let ownerToken: string;
  let otherToken: string;
  let ownerChannelId: string;
  let readyVideo: Video;
  let processingVideo: Video;
  let objectKeys: string[];
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

  async function findChannelIdByEmail(email: string): Promise<string> {
    const rows: { id: string }[] = await dataSource.query(
      'SELECT c.id FROM channels c JOIN users u ON u.id = c.user_id WHERE u.email = $1',
      [email],
    );
    return rows[0].id;
  }

  async function seedVideo(overrides: Partial<Video>): Promise<Video> {
    const id = randomUUID();
    return videoRepository.save(
      videoRepository.create({
        id,
        channel_id: ownerChannelId,
        slug: generateVideoSlug(),
        title: 'aula',
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        declared_size_bytes: videoBytes.length,
        original_key: `videos/${id}/original`,
        ...overrides,
      }),
    );
  }

  async function seedReadyVideo(): Promise<Video> {
    // A real MP4 in the dev bucket under a test-only prefix.
    const originalKey = `test-e2e/videos-stream/${randomUUID()}/original`;
    await storage.putObject(originalKey, videoBytes, 'video/mp4');
    objectKeys.push(originalKey);
    return seedVideo({
      processing_status: VideoProcessingStatus.READY,
      original_key: originalKey,
      duration_seconds: 1,
      width: 640,
      height: 360,
      video_codec: 'h264',
      audio_codec: 'aac',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      size_bytes: videoBytes.length,
      processed_at: new Date(),
    });
  }

  const getStream = (slug: string, token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .redirects(0);

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
    storage = moduleFixture.get(StorageService);
    publicEndpoint = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).publicEndpoint;

    const fixtures = await createMediaFixtures({ durationSeconds: 1 });
    try {
      videoBytes = await readFile(fixtures.videoPath);
    } finally {
      await fixtures.cleanup();
    }
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    objectKeys = [];
    const n = ++userCounter;
    const ownerEmail = `videos_stream_owner_${n}@example.com`;
    ownerToken = await registerConfirmAndLogin(ownerEmail);
    otherToken = await registerConfirmAndLogin(
      `videos_stream_other_${n}@example.com`,
    );
    ownerChannelId = await findChannelIdByEmail(ownerEmail);
    readyVideo = await seedReadyVideo();
    processingVideo = await seedVideo({
      processing_status: VideoProcessingStatus.PROCESSING,
    });
  });

  afterEach(async () => {
    // Remove what the test wrote to the dev bucket.
    for (const key of objectKeys) {
      await storage.deleteObject(key);
    }
    jest.restoreAllMocks();
  });

  // 1. GET /videos/:slug/stream

  it('redireciona-para-url-assinada-com-suporte-a-range', async () => {
    expect(videoBytes.length).toBeGreaterThanOrEqual(1024);

    const res = await getStream(readyVideo.slug, ownerToken).expect(302);

    const location = res.headers['location'];
    expect(typeof location).toBe('string');
    expect(new URL(location).origin).toBe(new URL(publicEndpoint).origin);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text ?? '').toBe('');
    expect(Number(res.headers['content-length'] ?? 0)).toBe(0);

    const ranged = await fetch(location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    const body = Buffer.from(await ranged.arrayBuffer());
    expect(body.length).toBe(1024);
    expect(body.equals(videoBytes.subarray(0, 1024))).toBe(true);
  });

  it('video-nao-ready-retorna-conflito', async () => {
    const res = await getStream(processingVideo.slug, ownerToken).expect(409);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_READY');
  });

  it('outro-usuario-recebe-not-found', async () => {
    const res = await getStream(readyVideo.slug, otherToken).expect(404);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });
});
