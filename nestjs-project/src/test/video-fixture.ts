import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface MediaFixtures {
  /** Short 640x360 MP4 (H.264, plus AAC unless `withAudio` is false). */
  videoPath: string;
  /** Control file that is not a video, for negative cases. */
  nonVideoPath: string;
  /** Removes the temporary directory holding both files. */
  cleanup: () => Promise<void>;
}

export interface MediaFixtureOptions {
  durationSeconds?: number;
  /** Adds an audio track to the video (default `true`). */
  withAudio?: boolean;
}

/**
 * Generates media fixtures in a temporary directory so no binary is versioned.
 * The video is filled with noise, which keeps it nearly incompressible
 * (about 11 MB for 3 seconds): big enough to be split into multipart parts
 * above the 5 MiB S3 minimum.
 */
export async function createMediaFixtures(
  options: MediaFixtureOptions = {},
): Promise<MediaFixtures> {
  const duration = options.durationSeconds ?? 3;
  const withAudio = options.withAudio ?? true;
  const audioInput = withAudio
    ? ['-f', 'lavfi', '-i', `sine=duration=${duration}`]
    : [];
  const audioOutput = withAudio ? ['-c:a', 'aac', '-shortest'] : ['-an'];
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  const videoPath = join(dir, 'sample.mp4');
  const nonVideoPath = join(dir, 'not-a-video.mp4');

  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${duration}:size=640x360:rate=25`,
      ...audioInput,
      '-vf',
      'noise=alls=100:allf=t',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      ...audioOutput,
      '-movflags',
      '+faststart',
      videoPath,
    ]);
    await writeFile(nonVideoPath, 'this file is plain text, not a video\n');
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    videoPath,
    nonVideoPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
