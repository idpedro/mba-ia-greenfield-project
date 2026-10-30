/** Metadata of a probed video, feeding the metadata columns of `Video`. */
export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  /** `null` when the file has no audio stream. */
  audioCodec: string | null;
  containerFormat: string;
  /** Overall bitrate in bits/s; `null` when ffprobe cannot tell it. */
  bitrate: number | null;
}
