import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { MAX_UPLOAD_PARTS } from '../upload-limits';
import { CompletedPartDto } from './completed-part.dto';

export class CompleteUploadDto {
  /** Every uploaded part with the ETag the storage returned for it. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_UPLOAD_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
