import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PART_URLS_PER_REQUEST } from '../upload-limits';

export class RequestPartUrlsDto {
  /**
   * Numbers of the parts to sign (1-based, no duplicates). Each must not
   * exceed the video's `part_count`.
   * @example [1, 2, 3]
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PART_URLS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
