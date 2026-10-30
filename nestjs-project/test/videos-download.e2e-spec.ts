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

describe('videos-download', () => {
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
  let accentedVideo: Video;
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

  async function seedReadyVideo(originalFilename: string): Promise<Video> {
    // A real MP4 in the dev bucket under a test-only prefix.
    const originalKey = `test-e2e/videos-download/${randomUUID()}/original`;
    await storage.putObject(originalKey, videoBytes, 'video/mp4');
    objectKeys.push(originalKey);
    return seedVideo({
      processing_status: VideoProcessingStatus.READY,
      original_key: originalKey,
      original_filename: originalFilename,
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

  const getDownload = (slug: string, token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
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
    const ownerEmail = `videos_download_owner_${n}@example.com`;
    ownerToken = await registerConfirmAndLogin(ownerEmail);
    otherToken = await registerConfirmAndLogin(
      `videos_download_other_${n}@example.com`,
    );
    ownerChannelId = await findChannelIdByEmail(ownerEmail);
    readyVideo = await seedReadyVideo('aula.mp4');
    accentedVideo = await seedReadyVideo('aula 1 — introdução.mp4');
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

  // 1. GET /videos/:slug/download

  it('redireciona-com-content-disposition-attachment', async () => {
    const res = await getDownload(readyVideo.slug, ownerToken).expect(302);

    const location = res.headers['location'];
    expect(typeof location).toBe('string');
    expect(new URL(location).origin).toBe(new URL(publicEndpoint).origin);
    expect(res.headers['cache-control']).toBe('no-store');

    const download = await fetch(location);
    expect(download.status).toBe(200);
    const disposition = download.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).toContain('aula.mp4');
    expect(Buffer.from(await download.arrayBuffer()).equals(videoBytes)).toBe(
      true,
    );
  });

  it('nome-com-acentos-usa-filename-estrela-utf8', async () => {
    const res = await getDownload(accentedVideo.slug, ownerToken).expect(302);

    const download = await fetch(res.headers['location']);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''aula%201%20%E2%80%94%20introdu%C3%A7%C3%A3o.mp4",
    );
    await download.arrayBuffer();
  });

  it('video-nao-ready-retorna-conflito', async () => {
    const res = await getDownload(processingVideo.slug, ownerToken).expect(409);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_READY');
  });

  it('outro-usuario-recebe-not-found', async () => {
    const res = await getDownload(readyVideo.slug, otherToken).expect(404);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });
});
