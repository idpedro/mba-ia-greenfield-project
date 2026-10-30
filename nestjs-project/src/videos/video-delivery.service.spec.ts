import { Test } from '@nestjs/testing';
import { StorageService } from '../storage';
import { Video } from './entities/video.entity';
import { PRESIGNED_URL_TTL_SECONDS } from './upload-limits';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoProcessingStatus } from './video.enums';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './video.exceptions';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const SLUG = 'dQw4w9WgXcQ';
const VIDEO_ID = '0b9e7c1e-5f0a-4d55-9a57-3f1f4c1d2e3a';
const SIGNED_URL = 'http://storage-public.test/bucket/videos/x/original?sig';

const buildVideo = (
  status: VideoProcessingStatus,
  originalFilename = 'aula.mp4',
): Video =>
  ({
    id: VIDEO_ID,
    slug: SLUG,
    processing_status: status,
    original_key: `videos/${VIDEO_ID}/original`,
    original_filename: originalFilename,
  }) as Video;

describe('VideoDeliveryService', () => {
  let service: VideoDeliveryService;
  const videosService = { findOwnedBySlug: jest.fn() };
  const storageService = { signGetUrl: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoDeliveryService,
        { provide: VideosService, useValue: videosService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();
    service = module.get(VideoDeliveryService);
  });

  describe('streamUrl', () => {
    it('should sign a GET of the original file on the public client for 1 hour', async () => {
      // Arrange
      videosService.findOwnedBySlug.mockResolvedValue(
        buildVideo(VideoProcessingStatus.READY),
      );
      storageService.signGetUrl.mockResolvedValue(SIGNED_URL);

      // Act
      const url = await service.streamUrl(SLUG, USER_ID);

      // Assert
      expect(url).toBe(SIGNED_URL);
      expect(videosService.findOwnedBySlug).toHaveBeenCalledWith(SLUG, USER_ID);
      expect(storageService.signGetUrl).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/original`,
        { expiresIn: PRESIGNED_URL_TTL_SECONDS, client: 'public' },
      );
      expect(PRESIGNED_URL_TTL_SECONDS).toBe(3600);
    });

    it.each([
      VideoProcessingStatus.PENDING_UPLOAD,
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.FAILED,
    ])(
      'should throw VideoNotReadyException without signing when the video is %s',
      async (status) => {
        // Arrange
        videosService.findOwnedBySlug.mockResolvedValue(buildVideo(status));

        // Act & Assert
        await expect(service.streamUrl(SLUG, USER_ID)).rejects.toBeInstanceOf(
          VideoNotReadyException,
        );
        expect(storageService.signGetUrl).not.toHaveBeenCalled();
      },
    );

    it('should propagate VideoNotFoundException when the video is not owned by the caller', async () => {
      // Arrange
      videosService.findOwnedBySlug.mockRejectedValue(
        new VideoNotFoundException(),
      );

      // Act & Assert
      await expect(service.streamUrl(SLUG, USER_ID)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      expect(storageService.signGetUrl).not.toHaveBeenCalled();
    });
  });
  describe('downloadUrl', () => {
    it.each([
      [
        'an ASCII name',
        'aula.mp4',
        `attachment; filename="aula.mp4"; filename*=UTF-8''aula.mp4`,
      ],
      [
        'a name with quotes and a backslash',
        'minha "aula" \\ 1.mp4',
        `attachment; filename="minha _aula_ _ 1.mp4"; filename*=UTF-8''minha%20%22aula%22%20%5C%201.mp4`,
      ],
      [
        'a name with accents and an em dash',
        'aula 1 — introdução.mp4',
        `attachment; filename="aula 1 _ introdu__o.mp4"; filename*=UTF-8''aula%201%20%E2%80%94%20introdu%C3%A7%C3%A3o.mp4`,
      ],
      [
        "a name with RFC 5987-reserved ' ( ) *",
        "it's (final)*.mp4",
        `attachment; filename="it's (final)*.mp4"; filename*=UTF-8''it%27s%20%28final%29%2A.mp4`,
      ],
    ])(
      'should sign an attachment Content-Disposition for %s',
      async (_case, originalFilename, expectedDisposition) => {
        // Arrange
        videosService.findOwnedBySlug.mockResolvedValue(
          buildVideo(VideoProcessingStatus.READY, originalFilename),
        );
        storageService.signGetUrl.mockResolvedValue(SIGNED_URL);

        // Act
        const url = await service.downloadUrl(SLUG, USER_ID);

        // Assert
        expect(url).toBe(SIGNED_URL);
        expect(videosService.findOwnedBySlug).toHaveBeenCalledWith(
          SLUG,
          USER_ID,
        );
        expect(storageService.signGetUrl).toHaveBeenCalledWith(
          `videos/${VIDEO_ID}/original`,
          {
            expiresIn: PRESIGNED_URL_TTL_SECONDS,
            client: 'public',
            contentDisposition: expectedDisposition,
          },
        );
      },
    );

    it.each([
      VideoProcessingStatus.PENDING_UPLOAD,
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.FAILED,
    ])(
      'should throw VideoNotReadyException without signing when the video is %s',
      async (status) => {
        // Arrange
        videosService.findOwnedBySlug.mockResolvedValue(buildVideo(status));

        // Act & Assert
        await expect(service.downloadUrl(SLUG, USER_ID)).rejects.toBeInstanceOf(
          VideoNotReadyException,
        );
        expect(storageService.signGetUrl).not.toHaveBeenCalled();
      },
    );

    it('should propagate VideoNotFoundException when the video is not owned by the caller', async () => {
      // Arrange
      videosService.findOwnedBySlug.mockRejectedValue(
        new VideoNotFoundException(),
      );

      // Act & Assert
      await expect(service.downloadUrl(SLUG, USER_ID)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      expect(storageService.signGetUrl).not.toHaveBeenCalled();
    });
  });
});
