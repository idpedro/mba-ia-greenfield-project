import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class VideoUploadPlanDto {
  @ApiProperty({ example: 67108864 })
  part_size_bytes: number;

  @ApiProperty({ example: 3 })
  part_count: number;
}

export class CreatedVideoResponseDto extends VideoResponseDto {
  @ApiProperty({ type: VideoUploadPlanDto })
  upload: VideoUploadPlanDto;
}
