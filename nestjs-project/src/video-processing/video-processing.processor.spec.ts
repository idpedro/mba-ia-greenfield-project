import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { StorageService } from '../storage';
import { Video } from '../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../videos/video.enums';
import { InvalidMediaError, MediaToolError } from './ffmpeg/ffmpeg.errors';
import { FfmpegService } from './ffmpeg/ffmpeg.service';
import type { ProbeResult } from './ffmpeg/ffmpeg.types';
import type { ProcessVideoJobData } from './video-processing.constants';
import {
  SOURCE_URL_TTL_SECONDS,
  VideoProcessingProcessor,
} from './video-processing.processor';

jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn(),
  readFile: jest.fn(),
  rm: jest.fn(),
}));

const WORK_DIR = '/tmp/streamtube-thumbnail-abc123';
const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const VIDEO_ID = '6f1c1d6e-2b8a-4e57-9f0e-0d4f1b6a9c11';
const SIGNED_URL = `http://rustfs:9000/streamtube/videos/${VIDEO_ID}/original?X-Amz=sig`;
const ATTEMPTS = 3;

const PROBE_RESULT: ProbeResult = {
  durationSeconds: 20,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
  containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
  bitrate: 4_500_000,
};

function buildVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: VIDEO_ID,
    processing_status: VideoProcessingStatus.PROCESSING,
    original_key: `videos/${VIDEO_ID}/original`,
    ...overrides,
  });
}

function buildJob(attemptsMade = 0): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts: ATTEMPTS },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  const videoRepository = {
    findOneBy: jest.fn(),
    update: jest.fn(),
  };
  const storage = {
    signGetUrl: jest.fn(),
    putObject: jest.fn(),
  };
  const ffmpeg = {
    probe: jest.fn(),
    extractFrame: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    videoRepository.findOneBy.mockResolvedValue(buildVideo());
    videoRepository.update.mockResolvedValue({ affected: 1 });
    storage.signGetUrl.mockResolvedValue(SIGNED_URL);
    storage.putObject.mockResolvedValue(undefined);
    ffmpeg.probe.mockResolvedValue(PROBE_RESULT);
    ffmpeg.extractFrame.mockResolvedValue(undefined);
    (mkdtemp as jest.Mock).mockResolvedValue(WORK_DIR);
    (readFile as jest.Mock).mockResolvedValue(FRAME);
    (rm as jest.Mock).mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storage },
        { provide: FfmpegService, useValue: ffmpeg },
      ],
    }).compile();
    processor = module.get(VideoProcessingProcessor);
  });

  describe('when the video is processed successfully', () => {
    it('should probe a GET URL signed with the internal client', async () => {
      await processor.process(buildJob());

      expect(storage.signGetUrl).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/original`,
        { expiresIn: SOURCE_URL_TTL_SECONDS, client: 'internal' },
      );
      expect(ffmpeg.probe).toHaveBeenCalledWith(SIGNED_URL);
    });

    it('should extract the frame at 10% of the duration and store it as the JPEG thumbnail', async () => {
      await processor.process(buildJob());

      expect(ffmpeg.extractFrame).toHaveBeenCalledWith(
        SIGNED_URL,
        2,
        `${WORK_DIR}/thumbnail.jpg`,
      );
      expect(readFile).toHaveBeenCalledWith(`${WORK_DIR}/thumbnail.jpg`);
      expect(storage.putObject).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/thumbnail.jpg`,
        FRAME,
        'image/jpeg',
      );
    });

    it('should delete the temporary directory afterwards', async () => {
      await processor.process(buildJob());

      expect(rm).toHaveBeenCalledWith(WORK_DIR, {
        recursive: true,
        force: true,
      });
    });

    it('should persist the metadata, thumbnail key and ready status in one update', async () => {
      await processor.process(buildJob());

      expect(videoRepository.update).toHaveBeenCalledTimes(1);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
        {
          duration_seconds: 20,
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
          bitrate: 4_500_000,
          thumbnail_key: `videos/${VIDEO_ID}/thumbnail.jpg`,
          processed_at: expect.any(Date) as Date,
          processing_status: VideoProcessingStatus.READY,
        },
      );
    });
  });

  describe('when the video is not processing', () => {
    it.each([
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
      VideoProcessingStatus.PENDING_UPLOAD,
    ])('should do nothing for a video in %s', async (status) => {
      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({ processing_status: status }),
      );

      await expect(processor.process(buildJob())).resolves.toBeUndefined();

      expect(storage.signGetUrl).not.toHaveBeenCalled();
      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should do nothing when the video no longer exists', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(processor.process(buildJob())).resolves.toBeUndefined();

      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('when the media is invalid', () => {
    it('should throw UnrecoverableError and mark the video failed with invalid_media', async () => {
      ffmpeg.probe.mockRejectedValue(
        new InvalidMediaError('Input has no video stream'),
      );

      const error: unknown = await processor
        .process(buildJob())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toBe('Input has no video stream');
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: VideoFailureReason.INVALID_MEDIA,
        },
      );
    });

    it('should not store a thumbnail', async () => {
      ffmpeg.probe.mockRejectedValue(new InvalidMediaError('bad media'));

      await expect(processor.process(buildJob())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(ffmpeg.extractFrame).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
    });
  });

  describe('when a retryable error happens', () => {
    it('should only rethrow it before the last attempt', async () => {
      const error = new MediaToolError('Connection refused');
      ffmpeg.probe.mockRejectedValue(error);

      await expect(processor.process(buildJob(0))).rejects.toBe(error);
      await expect(processor.process(buildJob(ATTEMPTS - 2))).rejects.toBe(
        error,
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should mark the video failed with processing_error on the last attempt and rethrow', async () => {
      const error = new Error('storage unreachable');
      storage.putObject.mockRejectedValue(error);

      await expect(processor.process(buildJob(ATTEMPTS - 1))).rejects.toBe(
        error,
      );

      expect(videoRepository.update).toHaveBeenCalledTimes(1);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: VideoFailureReason.PROCESSING_ERROR,
        },
      );
    });

    it('should treat a job without attempts as being on its last attempt', async () => {
      const error = new Error('boom');
      storage.signGetUrl.mockRejectedValue(error);
      const job = { ...buildJob(0), opts: {} } as Job<ProcessVideoJobData>;

      await expect(processor.process(job)).rejects.toBe(error);

      expect(videoRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          failure_reason: VideoFailureReason.PROCESSING_ERROR,
        }),
      );
    });

    it('should delete the temporary directory when storing the thumbnail fails', async () => {
      storage.putObject.mockRejectedValue(new Error('storage unreachable'));

      await expect(processor.process(buildJob())).rejects.toThrow(
        'storage unreachable',
      );

      expect(rm).toHaveBeenCalledWith(WORK_DIR, {
        recursive: true,
        force: true,
      });
    });

    it('should still rethrow the job error when marking the video failed fails', async () => {
      const error = new Error('storage unreachable');
      storage.signGetUrl.mockRejectedValue(error);
      videoRepository.update.mockRejectedValue(new Error('db down'));

      await expect(processor.process(buildJob(ATTEMPTS - 1))).rejects.toBe(
        error,
      );
    });
  });
});
