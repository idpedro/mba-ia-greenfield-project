import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  S3_ERROR_NAMES,
  S3_INTERNAL_CLIENT,
  STORAGE_BUCKET_CORS,
  STORAGE_BUCKET_LIFECYCLE,
} from './storage.constants';

/**
 * Makes the bucket ready on every boot: creates it when missing and (re)applies
 * CORS and the lifecycle backstop. Every step is idempotent.
 */
@Injectable()
export class StorageBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(StorageBootstrapService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
    await this.applyCors();
    await this.applyLifecycle();
  }

  private async ensureBucket(): Promise<void> {
    const bucket = this.config.bucket;
    if (await this.bucketExists(bucket)) {
      return;
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
      this.logger.log(`Created bucket ${bucket}`);
    } catch (error) {
      // Another process (API or worker) created it concurrently.
      if (
        error instanceof S3ServiceException &&
        error.name === S3_ERROR_NAMES.BUCKET_ALREADY_OWNED_BY_YOU
      ) {
        return;
      }
      throw error;
    }
  }

  private async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch (error) {
      // A missing bucket is a valid result here, not a failure.
      if (
        error instanceof S3ServiceException &&
        (error.name === S3_ERROR_NAMES.NOT_FOUND ||
          error.name === S3_ERROR_NAMES.NO_SUCH_BUCKET)
      ) {
        return false;
      }
      throw error;
    }
  }

  private async applyCors(): Promise<void> {
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.config.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: this.config.corsAllowedOrigins,
              AllowedMethods: [...STORAGE_BUCKET_CORS.ALLOWED_METHODS],
              AllowedHeaders: [...STORAGE_BUCKET_CORS.ALLOWED_HEADERS],
              ExposeHeaders: [...STORAGE_BUCKET_CORS.EXPOSE_HEADERS],
            },
          ],
        },
      }),
    );
  }

  private async applyLifecycle(): Promise<void> {
    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.config.bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: STORAGE_BUCKET_LIFECYCLE.ABORT_INCOMPLETE_MULTIPART_RULE_ID,
              Status: 'Enabled',
              Filter: { Prefix: '' },
              AbortIncompleteMultipartUpload: {
                DaysAfterInitiation:
                  STORAGE_BUCKET_LIFECYCLE.ABORT_INCOMPLETE_MULTIPART_DAYS,
              },
            },
          ],
        },
      }),
    );
  }
}
