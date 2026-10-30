import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CompletedPartDto {
  /**
   * Number of the uploaded part (1-based).
   * @example 1
   */
  @IsInt()
  @Min(1)
  part_number: number;

  /**
   * Value of the `ETag` response header returned by the storage for the part.
   * @example "\"9b2cf535f27731c974343645a3985328\""
   */
  @IsString()
  @IsNotEmpty()
  etag: string;
}
