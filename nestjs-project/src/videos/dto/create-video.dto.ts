import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ACCEPTED_VIDEO_MIME_TYPES,
  type AcceptedVideoMimeType,
  MAX_VIDEO_SIZE_BYTES,
} from '../upload-limits';

export class CreateVideoDto {
  /** Name of the file being uploaded, e.g. `aula.mp4`. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /** MIME type of the file. */
  // Explicit: the generated src/metadata.ts (openapi:metadata) cannot
  // reference imported constants, so the plugin alone would drop enum/maximum.
  @ApiProperty({ enum: ACCEPTED_VIDEO_MIME_TYPES })
  @IsIn(ACCEPTED_VIDEO_MIME_TYPES)
  mime_type: AcceptedVideoMimeType;

  /** Size of the file in bytes (at most 10 GiB). */
  @ApiProperty({ maximum: MAX_VIDEO_SIZE_BYTES })
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size_bytes: number;

  /** Video title; defaults to `filename` without its extension. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;
}
