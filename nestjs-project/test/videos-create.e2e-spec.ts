import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { CreatedVideoResponseDto } from '../src/videos/dto/created-video-response.dto';
import { Video } from '../src/videos/entities/video.entity';

const PASSWORD = 'password123';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const VALID_BODY = {
  filename: 'aula.mp4',
  mime_type: 'video/mp4',
  size_bytes: 200000000,
};

describe('videos-create', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let accessToken: string;
  let userEmail: string;
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
    userEmail = `videos_create_${++userCounter}@example.com`;
    accessToken = await registerConfirmAndLogin(userEmail);
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

  // 1. POST /videos

  it('cria-rascunho-e-abre-multipart', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(VALID_BODY)
      .expect(201);
    const body = res.body as CreatedVideoResponseDto;

    expect(body).toMatchObject({
      processing_status: 'pending_upload',
      publication_status: 'draft',
      title: 'aula',
    });
    expect(body.slug).toMatch(SLUG_PATTERN);
    expect(body.id).toMatch(UUID_PATTERN);
    expect(body.upload).toEqual({
      part_size_bytes: 67108864,
      part_count: 3,
    });
    expect(body).toMatchObject({
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      container_format: null,
      bitrate: null,
      size_bytes: null,
      thumbnail_url: null,
    });

    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: userEmail });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    const row = await videoRepository.findOneBy({ id: body.id });
    expect(row).not.toBeNull();
    expect(row!.channel_id).toBe(channel.id);
    expect(row!.upload_id).toEqual(expect.any(String));
    expect(row!.upload_id).not.toHaveLength(0);
    expect(row!.original_key).toBe(`videos/${body.id}/original`);
  });

  it('rejeita-tamanho-acima-de-10-gib', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ...VALID_BODY, size_bytes: 10737418241 })
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
    expect(await videoRepository.count()).toBe(0);
  });

  it('rejeita-mime-type-nao-suportado', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'foto.png', mime_type: 'image/png', size_bytes: 1000 })
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
    expect(await videoRepository.count()).toBe(0);
  });

  it('exige-autenticacao', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(VALID_BODY)
      .expect(401);

    expect(await videoRepository.count()).toBe(0);
  });
});
