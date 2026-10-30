import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageBootstrapService } from './storage-bootstrap.service';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

const buildS3Client = (
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    // Default flexible checksums embed the empty-body CRC32 in presigned
    // UploadPart URLs, so the storage rejects the browser's PUT (BadDigest).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

@Module({
  providers: [
    {
      // Server-side calls over the Compose network.
      provide: S3_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>): S3Client =>
        buildS3Client(config, config.endpoint),
    },
    {
      // Only signs URLs handed to the browser; never used to send requests.
      provide: S3_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>): S3Client =>
        buildS3Client(config, config.publicEndpoint),
    },
    StorageService,
    StorageBootstrapService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
