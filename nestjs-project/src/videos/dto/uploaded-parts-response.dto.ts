import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  /** `ETag` stored for the part; send it back when completing the upload. */
  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size_bytes: number;
}

export class UploadedPartsResponseDto {
  /** Parts already stored, ordered by `part_number`. */
  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];
}
