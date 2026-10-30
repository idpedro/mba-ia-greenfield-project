import { Test } from '@nestjs/testing';
import { execFile, type ExecFileException } from 'child_process';
import { InvalidMediaError, MediaToolError } from './ffmpeg.errors';
import {
  EXTRACT_FRAME_TIMEOUT_MS,
  FfmpegService,
  PROBE_TIMEOUT_MS,
  thumbnailTimestamp,
} from './ffmpeg.service';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

type ExecCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

const execFileMock = execFile as unknown as jest.Mock;

const INPUT_URL = 'http://rustfs:9000/streamtube/videos/id/original?X-Amz=sig';

function mockExecResult(
  error: ExecFileException | null,
  stdout = '',
  stderr = '',
): void {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _options: object, cb: ExecCallback) => {
      cb(error, stdout, stderr);
    },
  );
}

function exitError(code: number): ExecFileException {
  return Object.assign(new Error(`Command failed with code ${code}`), {
    code,
    killed: false,
  });
}

function probeJson(
  overrides: {
    streams?: object[];
    format?: object;
  } = {},
): string {
  return JSON.stringify({
    streams: overrides.streams ?? [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        duration: '12.480000',
      },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
    ],
    format: overrides.format ?? {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '12.500000',
      bit_rate: '4500000',
    },
  });
}

describe('FfmpegService', () => {
  let service: FfmpegService;

  beforeEach(async () => {
    execFileMock.mockReset();
    const module = await Test.createTestingModule({
      providers: [FfmpegService],
    }).compile();
    service = module.get(FfmpegService);
  });

  describe('probe', () => {
    it('should run ffprobe with JSON output on the URL and a timeout', async () => {
      mockExecResult(null, probeJson());

      await service.probe(INPUT_URL);

      expect(execFileMock).toHaveBeenCalledWith(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          INPUT_URL,
        ],
        expect.objectContaining({ timeout: PROBE_TIMEOUT_MS }),
        expect.any(Function),
      );
    });

    it('should map format and first video/audio streams into a ProbeResult', async () => {
      mockExecResult(null, probeJson());

      const result = await service.probe(INPUT_URL);

      expect(result).toEqual({
        durationSeconds: 12.5,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate: 4500000,
      });
    });

    it('should use the first stream of each type when there are several', async () => {
      mockExecResult(
        null,
        probeJson({
          streams: [
            { codec_type: 'audio', codec_name: 'opus' },
            {
              codec_type: 'video',
              codec_name: 'vp9',
              width: 640,
              height: 360,
            },
            { codec_type: 'audio', codec_name: 'aac' },
            {
              codec_type: 'video',
              codec_name: 'mjpeg',
              width: 100,
              height: 100,
            },
          ],
        }),
      );

      const result = await service.probe(INPUT_URL);

      expect(result).toMatchObject({
        videoCodec: 'vp9',
        width: 640,
        height: 360,
        audioCodec: 'opus',
      });
    });

    it('should return audioCodec null when there is no audio stream', async () => {
      mockExecResult(
        null,
        probeJson({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 640,
              height: 360,
            },
          ],
        }),
      );

      const result = await service.probe(INPUT_URL);

      expect(result.audioCodec).toBeNull();
    });

    it('should fall back to the video stream duration when the format has none', async () => {
      mockExecResult(
        null,
        probeJson({
          format: { format_name: 'matroska,webm', bit_rate: '800000' },
        }),
      );

      const result = await service.probe(INPUT_URL);

      expect(result.durationSeconds).toBe(12.48);
    });

    it('should return bitrate null when ffprobe reports it as N/A', async () => {
      mockExecResult(
        null,
        probeJson({
          format: { format_name: 'mpegts', duration: '3.0', bit_rate: 'N/A' },
        }),
      );

      const result = await service.probe(INPUT_URL);

      expect(result.bitrate).toBeNull();
    });

    it('should throw InvalidMediaError when there is no video stream', async () => {
      mockExecResult(
        null,
        probeJson({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }] }),
      );

      await expect(service.probe(INPUT_URL)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should throw InvalidMediaError when the video stream has no dimensions', async () => {
      mockExecResult(
        null,
        probeJson({ streams: [{ codec_type: 'video', codec_name: 'h264' }] }),
      );

      await expect(service.probe(INPUT_URL)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should throw InvalidMediaError when ffprobe exits non-zero on unreadable media', async () => {
      mockExecResult(
        exitError(1),
        '{}',
        `${INPUT_URL}: Invalid data found when processing input\n`,
      );

      const probing = service.probe(INPUT_URL);

      await expect(probing).rejects.toBeInstanceOf(InvalidMediaError);
      await expect(probing).rejects.toThrow('Invalid data found');
    });

    it.each([
      'Server returned 403 Forbidden (access denied)',
      'Server returned 5XX Server Error reply',
      'Connection to tcp://rustfs:9000 failed: Connection refused',
      'Failed to resolve hostname rustfs: Name or service not known',
      'Input/output error',
      'Connection timed out',
    ])(
      'should throw MediaToolError when ffprobe cannot reach the input (%s)',
      async (stderr) => {
        mockExecResult(exitError(1), '{}', `${INPUT_URL}: ${stderr}\n`);

        await expect(service.probe(INPUT_URL)).rejects.toBeInstanceOf(
          MediaToolError,
        );
      },
    );

    it('should throw MediaToolError when ffprobe is killed by the timeout', async () => {
      const timeout = Object.assign(new Error('Command failed'), {
        code: null as unknown as number,
        killed: true,
        signal: 'SIGTERM' as NodeJS.Signals,
      });
      mockExecResult(timeout);

      await expect(service.probe(INPUT_URL)).rejects.toBeInstanceOf(
        MediaToolError,
      );
    });

    it('should throw MediaToolError when the binary cannot be started', async () => {
      const notFound = Object.assign(new Error('spawn ffprobe ENOENT'), {
        code: 'ENOENT',
      }) as ExecFileException;
      mockExecResult(notFound);

      await expect(service.probe(INPUT_URL)).rejects.toBeInstanceOf(
        MediaToolError,
      );
    });
  });

  describe('extractFrame', () => {
    const OUTPUT_PATH = '/tmp/thumb.jpg';

    it('should seek before the input and write one 1280px-wide JPEG frame', async () => {
      mockExecResult(null);

      await service.extractFrame(INPUT_URL, 1.25, OUTPUT_PATH);

      const [file, args, options] = execFileMock.mock.calls[0] as [
        string,
        string[],
        { timeout: number },
      ];
      expect(file).toBe('ffmpeg');
      expect(options.timeout).toBe(EXTRACT_FRAME_TIMEOUT_MS);
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
      expect(args[args.indexOf('-ss') + 1]).toBe('1.25');
      expect(args[args.indexOf('-i') + 1]).toBe(INPUT_URL);
      expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
      expect(args[args.indexOf('-vf') + 1]).toBe('scale=1280:-2');
      expect(args[args.indexOf('-c:v') + 1]).toBe('mjpeg');
      expect(args[args.length - 1]).toBe(OUTPUT_PATH);
    });

    it('should throw MediaToolError when ffmpeg fails', async () => {
      mockExecResult(exitError(1), '', 'Server returned 404 Not Found');

      await expect(
        service.extractFrame(INPUT_URL, 0, OUTPUT_PATH),
      ).rejects.toBeInstanceOf(MediaToolError);
    });
  });
});

describe('FfmpegService error messages', () => {
  const PRESIGNED_URL =
    'http://rustfs:9000/streamtube/videos/id/original' +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261030%2Fus-east-1%2Fs3%2Faws4_request' +
    '&X-Amz-Date=20261030T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host' +
    '&X-Amz-Signature=deadbeefcafe';
  const REDACTED_URL = 'http://rustfs:9000/streamtube/videos/id/original';
  const SECRETS = ['X-Amz-', 'deadbeefcafe', 'AKIA', '?'];
  let service: FfmpegService;

  function expectNoPresignedQuery(error: unknown): void {
    const { message } = error as Error;
    for (const secret of SECRETS) {
      expect(message).not.toContain(secret);
    }
  }

  function commandFailed(code: number, killed = false): ExecFileException {
    // Node puts the whole command line, URL included, in the message.
    return Object.assign(
      new Error(`Command failed: ffprobe -v error ${PRESIGNED_URL}`),
      { code, killed },
    );
  }

  beforeEach(async () => {
    execFileMock.mockReset();
    const module = await Test.createTestingModule({
      providers: [FfmpegService],
    }).compile();
    service = module.get(FfmpegService);
  });

  it('should redact the URL echoed in stderr of an InvalidMediaError', async () => {
    mockExecResult(
      commandFailed(1),
      '{}',
      `${PRESIGNED_URL}: Invalid data found when processing input\n`,
    );

    const error = await service.probe(PRESIGNED_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidMediaError);
    expectNoPresignedQuery(error);
    expect((error as Error).message).toContain(
      `${REDACTED_URL}: Invalid data found`,
    );
  });

  it('should redact the URL echoed in stderr of a MediaToolError', async () => {
    mockExecResult(
      commandFailed(1),
      '{}',
      `[http @ 0x1] HTTP error 403 Forbidden\n${PRESIGNED_URL}: Server returned 403 Forbidden (access denied)\n`,
    );

    const error = await service.probe(PRESIGNED_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MediaToolError);
    expectNoPresignedQuery(error);
    expect((error as Error).message).toContain(REDACTED_URL);
  });

  it('should redact the URL in the exec error message when stderr is empty (timeout)', async () => {
    mockExecResult(commandFailed(null as unknown as number, true));

    const error = await service.probe(PRESIGNED_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MediaToolError);
    expect((error as Error).message).toContain('timed out or killed');
    expectNoPresignedQuery(error);
  });

  it('should redact the URL from extractFrame failures', async () => {
    mockExecResult(
      commandFailed(1),
      '',
      `${PRESIGNED_URL}: Server returned 404 Not Found\n`,
    );

    const error = await service
      .extractFrame(PRESIGNED_URL, 0, '/tmp/thumb.jpg')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MediaToolError);
    expectNoPresignedQuery(error);
    expect((error as Error).message).toContain(REDACTED_URL);
  });

  it('should still pass the full presigned URL to the binary', async () => {
    mockExecResult(null, probeJson());

    await service.probe(PRESIGNED_URL);

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain(PRESIGNED_URL);
  });
});

describe('thumbnailTimestamp', () => {
  it('should return 10% of the duration', () => {
    expect(thumbnailTimestamp(120)).toBe(12);
  });

  it('should return 0.1 for a clip of exactly one second', () => {
    expect(thumbnailTimestamp(1)).toBe(0.1);
  });

  it('should return 0 for clips shorter than one second', () => {
    expect(thumbnailTimestamp(0.5)).toBe(0);
    expect(thumbnailTimestamp(0)).toBe(0);
  });
});
