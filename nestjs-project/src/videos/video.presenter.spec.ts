import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage';
import { Video } from './entities/video.entity';
import { VideoProcessingStatus, VideoPublicationStatus } from './video.enums';
import { VideoPresenter } from './video.presenter';
import { PRESIGNED_URL_TTL_SECONDS } from './upload-limits';

const testStorageConfig = {
  endpoint: 'http://storage-internal.test:9000',
  publicEndpoint: 'http://storage-public.test:9100',
  region: 'us-east-1',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'test-bucket',
  corsAllowedOrigins: ['http://app.test'],
};

function buildVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: '7d0f4f8e-4a5b-4c1e-9f0a-2b3c4d5e6f70',
    channel_id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    slug: 'dQw4w9WgXcQ',
    title: 'aula',
    original_filename: 'aula.mp4',
    mime_type: 'video/mp4',
    declared_size_bytes: 1000,
    processing_status: VideoProcessingStatus.PENDING_UPLOAD,
    publication_status: VideoPublicationStatus.DRAFT,
    failure_reason: null,
    upload_id: 'upload-1',
    original_key: 'videos/7d0f4f8e/original',
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
    created_at: new Date('2026-10-30T10:00:00.000Z'),
    updated_at: new Date('2026-10-30T10:00:00.000Z'),
    ...overrides,
  });
}

describe('VideoPresenter', () => {
  let module: TestingModule;
  let presenter: VideoPresenter;

  beforeAll(async () => {
    // Real StorageService with a test config: signing is local, no request
    // reaches the storage (compile() does not run onModuleInit).
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [VideoPresenter],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(testStorageConfig)
      .compile();
    presenter = module.get(VideoPresenter);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should return a null thumbnail_url when the video has no thumbnail_key', async () => {
    // Act
    const response = await presenter.toResponse(buildVideo());

    // Assert
    expect(response.thumbnail_url).toBeNull();
  });

  it('should sign thumbnail_url on the public endpoint for 1 hour when thumbnail_key is set', async () => {
    // Arrange
    const video = buildVideo({
      processing_status: VideoProcessingStatus.READY,
      thumbnail_key: 'videos/7d0f4f8e/thumbnail.jpg',
    });

    // Act
    const response = await presenter.toResponse(video);

    // Assert
    const url = new URL(response.thumbnail_url as string);
    expect(url.origin).toBe(testStorageConfig.publicEndpoint);
    expect(url.pathname).toBe(
      `/${testStorageConfig.bucket}/videos/7d0f4f8e/thumbnail.jpg`,
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe(
      String(PRESIGNED_URL_TTL_SECONDS),
    );
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('should format created_at and processed_at as ISO-8601', async () => {
    // Arrange
    const video = buildVideo({
      processing_status: VideoProcessingStatus.READY,
      processed_at: new Date('2026-10-30T10:05:30.250Z'),
    });

    // Act
    const response = await presenter.toResponse(video);

    // Assert
    expect(response.created_at).toBe('2026-10-30T10:00:00.000Z');
    expect(response.processed_at).toBe('2026-10-30T10:05:30.250Z');
  });

  it('should return a null processed_at while the video is not processed', async () => {
    // Act
    const response = await presenter.toResponse(buildVideo());

    // Assert
    expect(response.processed_at).toBeNull();
  });

  it('should not expose storage internals', async () => {
    // Act
    const response = await presenter.toResponse(
      buildVideo({ thumbnail_key: 'videos/7d0f4f8e/thumbnail.jpg' }),
    );

    // Assert
    expect(response).not.toHaveProperty('upload_id');
    expect(response).not.toHaveProperty('original_key');
    expect(response).not.toHaveProperty('thumbnail_key');
    expect(response).not.toHaveProperty('channel_id');
    expect(response).not.toHaveProperty('declared_size_bytes');
  });
});
