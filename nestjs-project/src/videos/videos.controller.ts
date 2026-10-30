import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreatedVideoResponseDto } from './dto/created-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { ParseVideoSlugPipe } from './parse-video-slug.pipe';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoUploadService } from './video-upload.service';
import { VideoPresenter } from './video.presenter';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videoUploadService: VideoUploadService,
    private readonly videosService: VideosService,
    private readonly videoPresenter: VideoPresenter,
    private readonly videoDeliveryService: VideoDeliveryService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Creates the video as a draft in the caller's channel and opens the multipart upload of its file. The response tells how many parts of which size the client must send.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    type: CreatedVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (unsupported mime_type, size_bytes above 10 GiB, missing fields)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreatedVideoResponseDto> {
    const { video, upload } = await this.videoUploadService.initiate(
      user.sub,
      dto,
    );
    return { ...(await this.videoPresenter.toResponse(video)), upload };
  }

  @Post(':id/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign part upload URLs',
    description:
      "Signs presigned PUT URLs for the given parts of the caller's pending multipart upload. The client sends each part's bytes directly to the storage. Call it at start and again on resume, since the URLs expire after 1 hour.",
  })
  @ApiResponse({
    status: 200,
    description: 'Part URLs signed',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR when the body is invalid or :id is not a uuid; INVALID_PART_NUMBER when a part_number exceeds the part count',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "Video does not exist or is not in the caller's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not pending',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    const { parts, expires_at } = await this.videoUploadService.signPartUrls(
      id,
      user.sub,
      dto.part_numbers,
    );
    return { parts, expires_at: expires_at.toISOString() };
  }

  @Get(':id/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      "Lists the parts already stored in the caller's pending multipart upload, ordered by part number, so an interrupted upload can be resumed by sending only the missing parts.",
  })
  @ApiResponse({
    status: 200,
    description: 'Parts already stored',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR when :id is not a uuid',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "Video does not exist or is not in the caller's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not pending',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsResponseDto> {
    const parts = await this.videoUploadService.listUploadedParts(id, user.sub);
    return { parts };
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload with the ETag of every part, checks the stored size against the declared one and starts the automatic processing of the video.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; the video is now processing',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR when the body is invalid or :id is not a uuid; UPLOAD_INCOMPLETE when the storage rejects the part list (the upload stays open for a retry)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "Video does not exist or is not in the caller's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not pending (includes a repeated complete)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'Stored size differs from the declared one; the file is deleted and the video marked as failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.videoUploadService.complete(
      id,
      user.sub,
      dto.parts,
    );
    return this.videoPresenter.toResponse(video);
  }

  @Get(':slug')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a video',
    description:
      "Returns the caller's video addressed by its slug, with its processing status, the extracted metadata and a presigned thumbnail URL (valid for 1 hour) once processing is done.",
  })
  @ApiResponse({
    status: 200,
    description: 'Video and its processing status',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      "Slug is malformed, does not exist or belongs to a video outside the caller's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findBySlug(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnedBySlug(slug, user.sub);
    return this.videoPresenter.toResponse(video);
  }

  @Get(':slug/stream')
  @HttpCode(HttpStatus.FOUND)
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects the owner to a presigned GET URL of the original file (valid for 1 hour) on the storage, which answers Range requests with 206, so the video plays without being fully downloaded and its bytes never pass through the API.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirect to the presigned URL of the video file; the response has no body',
    headers: {
      Location: {
        description: 'Presigned GET URL of the video file, valid for 1 hour',
        schema: { type: 'string', format: 'uri' },
      },
      'Cache-Control': {
        description: 'Always no-store: the URL expires',
        schema: { type: 'string', example: 'no-store' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      "Slug is malformed, does not exist or belongs to a video outside the caller's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready (its processing has not finished)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const url = await this.videoDeliveryService.streamUrl(slug, user.sub);
    // Set Location directly instead of @Redirect(): Express's res.redirect()
    // writes a "Found. Redirecting to ..." body, and the 302 must be empty.
    res.location(url);
  }

  @Get(':slug/download')
  @HttpCode(HttpStatus.FOUND)
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects the owner to a presigned GET URL of the original file (valid for 1 hour) on the storage. The storage answers with Content-Disposition: attachment and the original file name (RFC 6266, with an RFC 5987 filename* for non-ASCII names), so the browser saves the file; its bytes never pass through the API.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirect to the presigned download URL of the video file; the response has no body',
    headers: {
      Location: {
        description:
          'Presigned GET URL of the video file with response-content-disposition, valid for 1 hour',
        schema: { type: 'string', format: 'uri' },
      },
      'Cache-Control': {
        description: 'Always no-store: the URL expires',
        schema: { type: 'string', example: 'no-store' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      "Slug is malformed, does not exist or belongs to a video outside the caller's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready (its processing has not finished)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const url = await this.videoDeliveryService.downloadUrl(slug, user.sub);
    // Same as stream(): no @Redirect(), so the 302 has no body.
    res.location(url);
  }
}
