import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import storageConfig from '../src/config/storage.config';
import { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { CreatedVideoResponseDto } from '../src/videos/dto/created-video-response.dto';
import { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { Video } from '../src/videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../src/videos/video.enums';
import { generateVideoSlug } from '../src/videos/video-slug.util';

const execFileAsync = promisify(execFile);

const PASSWORD = 'password123';
const CREATE_BODY = {
  filename: 'aula.mp4',
  mime_type: 'video/mp4',
  size_bytes: 200000000,
};

/** A real 320x180 JPEG produced by ffmpeg, so nothing binary is versioned. */
async function generateJpeg(): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180',
      '-frames:v',
      '1',
      '-f',
      'mjpeg',
      'pipe:1',
    ],
    { encoding: 'buffer' },
  );
  return stdout;
}

describe('videos-detail', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let publicEndpoint: string;
  let thumbnailJpeg: Buffer;
  let ownerToken: string;
  let otherToken: string;
  let ownerChannelId: string;
  let thumbnailKeys: string[];
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
        declared_size_bytes: 11000000,
        original_key: `videos/${id}/original`,
        ...overrides,
      }),
    );
  }

  async function seedReadyVideo(): Promise<Video> {
    const thumbnailKey = `test-e2e/videos-detail/${randomUUID()}/thumbnail.jpg`;
    await storage.putObject(thumbnailKey, thumbnailJpeg, 'image/jpeg');
    thumbnailKeys.push(thumbnailKey);
    return seedVideo({
      processing_status: VideoProcessingStatus.READY,
      thumbnail_key: thumbnailKey,
      duration_seconds: 3.04,
      width: 640,
      height: 360,
      video_codec: 'h264',
      audio_codec: 'aac',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate: 29000000,
      size_bytes: 11000000,
      processed_at: new Date(),
    });
  }

  const getVideo = (slug: string, token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${slug}`)
      .set('Authorization', `Bearer ${token}`);

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
    thumbnailJpeg = await generateJpeg();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    thumbnailKeys = [];
    const n = ++userCounter;
    const ownerEmail = `videos_detail_owner_${n}@example.com`;
    ownerToken = await registerConfirmAndLogin(ownerEmail);
    otherToken = await registerConfirmAndLogin(
      `videos_detail_other_${n}@example.com`,
    );
    ownerChannelId = await findChannelIdByEmail(ownerEmail);
  });

  afterEach(async () => {
    // Remove what the test wrote to the dev bucket.
    for (const key of thumbnailKeys) {
      await storage.deleteObject(key);
    }
    const open = await videoRepository.findBy({ upload_id: Not(IsNull()) });
    for (const video of open) {
      await storage.abortMultipartUpload(
        video.original_key,
        video.upload_id as string,
      );
    }
    jest.restoreAllMocks();
  });

  // 1. GET /videos/:slug

  it('video-ready-com-metadados-e-thumbnail', async () => {
    const video = await seedReadyVideo();

    const res = await getVideo(video.slug, ownerToken).expect(200);

    const body = res.body as VideoResponseDto;
    expect(body).toMatchObject({
      id: video.id,
      slug: video.slug,
      processing_status: 'ready',
      duration_seconds: 3.04,
      width: 640,
      height: 360,
      video_codec: 'h264',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      size_bytes: 11000000,
    });
    expect(body.thumbnail_url).not.toBeNull();
    const thumbnailUrl = body.thumbnail_url as string;
    expect(new URL(thumbnailUrl).origin).toBe(new URL(publicEndpoint).origin);

    const thumbnail = await fetch(thumbnailUrl);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  it('video-pending-upload-sem-metadados', async () => {
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(CREATE_BODY)
      .expect(201);
    const { slug } = created.body as CreatedVideoResponseDto;

    const res = await getVideo(slug, ownerToken).expect(200);

    expect(res.body).toMatchObject({
      processing_status: 'pending_upload',
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      container_format: null,
      bitrate: null,
      size_bytes: null,
      processed_at: null,
      thumbnail_url: null,
    });
  });

  it('video-failed-com-failure-reason', async () => {
    const video = await seedVideo({
      processing_status: VideoProcessingStatus.FAILED,
      failure_reason: VideoFailureReason.INVALID_MEDIA,
      processed_at: new Date(),
    });

    const res = await getVideo(video.slug, ownerToken).expect(200);

    expect(res.body).toMatchObject({
      processing_status: 'failed',
      failure_reason: 'invalid_media',
    });
  });

  it('outro-usuario-recebe-not-found', async () => {
    const video = await seedReadyVideo();

    const res = await getVideo(video.slug, otherToken).expect(404);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });

  it('slug-inexistente-ou-malformado-recebe-not-found', async () => {
    const missing = await getVideo(generateVideoSlug(), ownerToken).expect(404);
    expect((missing.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');

    const malformed = await getVideo('curto', ownerToken).expect(404);
    expect((malformed.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });
});
