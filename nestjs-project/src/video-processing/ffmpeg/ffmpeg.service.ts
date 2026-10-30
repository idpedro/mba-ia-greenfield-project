import { Injectable } from '@nestjs/common';
import { execFile, type ExecFileException } from 'child_process';
import { InvalidMediaError, MediaToolError } from './ffmpeg.errors';
import type { ProbeResult } from './ffmpeg.types';
import { redactPresignedUrls } from './redact-url';

export const PROBE_TIMEOUT_MS = 60_000;
export const EXTRACT_FRAME_TIMEOUT_MS = 120_000;
export const THUMBNAIL_WIDTH = 1280;

// Large enough for the JSON of files with many streams.
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SHORT_CLIP_SECONDS = 1;

// ffmpeg messages that mean the input could not be reached, as opposed to
// reached but unreadable as media.
const UNREACHABLE_INPUT_PATTERNS = [
  /Server returned/i,
  /HTTP error/i,
  /Connection refused/i,
  /Connection reset/i,
  /Connection timed out/i,
  /Failed to resolve hostname/i,
  /Network is unreachable/i,
  /Input\/output error/i,
];

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

/** Internal: an execFile run that failed, with the stderr it printed. */
class CommandFailure extends Error {
  constructor(
    readonly error: ExecFileException,
    readonly stderr: string,
  ) {
    super(stderr.trim() || error.message, { cause: error });
  }
}

/**
 * Frame position for the thumbnail: 10% of the duration, or the first frame
 * for clips shorter than one second (TD-13).
 */
export function thumbnailTimestamp(durationSeconds: number): number {
  if (durationSeconds < SHORT_CLIP_SECONDS) {
    return 0;
  }
  return durationSeconds / 10;
}

/** Typed wrapper over the ffprobe/ffmpeg binaries, run without a shell. */
@Injectable()
export class FfmpegService {
  async probe(inputUrl: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      stdout = await this.run(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputUrl,
        ],
        PROBE_TIMEOUT_MS,
      );
    } catch (failure) {
      throw this.classifyProbeFailure(failure as CommandFailure, inputUrl);
    }
    return this.mapProbeOutput(stdout);
  }

  /** Writes one JPEG frame, 1280 px wide with the source aspect ratio. */
  async extractFrame(
    inputUrl: string,
    atSeconds: number,
    outputPath: string,
  ): Promise<void> {
    try {
      await this.run(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          // Before -i: seeks the input, so only the needed range is fetched.
          '-ss',
          String(atSeconds),
          '-i',
          inputUrl,
          '-frames:v',
          '1',
          '-vf',
          `scale=${THUMBNAIL_WIDTH}:-2`,
          '-f',
          'image2',
          '-c:v',
          'mjpeg',
          outputPath,
        ],
        EXTRACT_FRAME_TIMEOUT_MS,
      );
    } catch (failure) {
      const commandFailure = failure as CommandFailure;
      throw new MediaToolError(
        `ffmpeg failed to extract a frame: ${this.describe(commandFailure, inputUrl)}`,
        { cause: commandFailure.error },
      );
    }
  }

  private run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES },
        (error, stdout, stderr) => {
          if (error) {
            reject(new CommandFailure(error, String(stderr)));
            return;
          }
          resolve(String(stdout));
        },
      );
    });
  }

  private classifyProbeFailure(
    failure: CommandFailure,
    inputUrl: string,
  ): Error {
    const { error, stderr } = failure;
    const message = `ffprobe failed: ${this.describe(failure, inputUrl)}`;
    // Killed (timeout) or not started at all (e.g. ENOENT): transient.
    const exitedWithCode = typeof error.code === 'number' && !error.killed;
    const unreachable = UNREACHABLE_INPUT_PATTERNS.some((pattern) =>
      pattern.test(stderr),
    );
    if (exitedWithCode && !unreachable) {
      return new InvalidMediaError(message, { cause: error });
    }
    return new MediaToolError(message, { cause: error });
  }

  private mapProbeOutput(stdout: string): ProbeResult {
    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      throw new MediaToolError('ffprobe returned invalid JSON', {
        cause: error,
      });
    }

    const streams = output.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    if (!video) {
      throw new InvalidMediaError('Input has no video stream');
    }

    const durationSeconds =
      this.toNumber(output.format?.duration) ?? this.toNumber(video.duration);
    if (
      durationSeconds === null ||
      !video.codec_name ||
      !video.width ||
      !video.height ||
      !output.format?.format_name
    ) {
      throw new InvalidMediaError(
        'Video stream lacks duration, codec, dimensions or container format',
      );
    }

    return {
      durationSeconds,
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name ?? null,
      containerFormat: output.format.format_name,
      bitrate: this.toNumber(output.format.bit_rate),
    };
  }

  // ffprobe prints numbers as strings and "N/A" when unknown.
  private toNumber(value: string | undefined): number | null {
    if (value === undefined) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // stderr and the exec error message echo the presigned input URL; only its
  // origin and path may reach error messages and logs.
  private describe(failure: CommandFailure, inputUrl: string): string {
    const detail = redactPresignedUrls(failure.message, inputUrl);
    return failure.error.killed ? `timed out or killed (${detail})` : detail;
  }
}
