import { ApiProperty } from '@nestjs/swagger';
import { VideoProcessingStatus, VideoPublicationStatus } from '../video.enums';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', minLength: 11, maxLength: 11 })
  slug: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ example: 'aula.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({
    enum: VideoProcessingStatus,
    enumName: 'VideoProcessingStatus',
  })
  processing_status: VideoProcessingStatus;

  @ApiProperty({
    enum: VideoPublicationStatus,
    enumName: 'VideoPublicationStatus',
  })
  publication_status: VideoPublicationStatus;

  @ApiProperty({ type: String, nullable: true, example: null })
  failure_reason: string | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  audio_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  container_format: string | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  bitrate: number | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  size_bytes: number | null;

  /** Presigned GET URL, present only once the thumbnail exists. */
  @ApiProperty({ type: String, nullable: true, example: null })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processed_at: string | null;
}
