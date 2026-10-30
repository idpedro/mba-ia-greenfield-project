import { ApiProperty } from '@nestjs/swagger';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  /** Presigned `UploadPart` URL; PUT the part bytes to it as-is. */
  @ApiProperty({
    example:
      'https://storage.example.com/streamtube/videos/0b9e.../original?partNumber=1&uploadId=...&X-Amz-Signature=...',
  })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  parts: PartUrlDto[];

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}
