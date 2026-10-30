import {
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  buildTestStorageConfig,
  createTestS3Client,
  deleteTestBucket,
  type StorageTestConfig,
} from '../test/storage';
import { StorageModule } from './storage.module';

describe('StorageBootstrapService (integration)', () => {
  const config: StorageTestConfig = buildTestStorageConfig({
    corsAllowedOrigins: ['http://app.streamtube.test'],
  });
  let adminClient: S3Client;

  const bootStorageModule = async (): Promise<void> => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .compile();
    // init() triggers onModuleInit, the same hook that runs on API boot.
    await module.init();
    await module.close();
  };

  beforeAll(async () => {
    adminClient = createTestS3Client(config);
    await deleteTestBucket(adminClient, config.bucket);
  });

  afterAll(async () => {
    await deleteTestBucket(adminClient, config.bucket);
    adminClient.destroy();
  });

  describe('after two consecutive boots against a missing bucket', () => {
    beforeAll(async () => {
      await bootStorageModule();
      await bootStorageModule();
    }, 30000);

    it('should have created the bucket', async () => {
      await expect(
        adminClient.send(new HeadBucketCommand({ Bucket: config.bucket })),
      ).resolves.toBeDefined();
    });

    it('should expose ETag and allow PUT from the configured origins', async () => {
      const cors = await adminClient.send(
        new GetBucketCorsCommand({ Bucket: config.bucket }),
      );

      expect(cors.CORSRules).toHaveLength(1);
      const [rule] = cors.CORSRules ?? [];
      expect(rule.AllowedOrigins).toEqual(config.corsAllowedOrigins);
      expect(rule.AllowedMethods).toEqual(
        expect.arrayContaining(['PUT', 'GET', 'HEAD']),
      );
      expect(rule.ExposeHeaders).toContain('ETag');
    });

    it('should abort incomplete multipart uploads after two days', async () => {
      const lifecycle = await adminClient.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: config.bucket }),
      );

      expect(lifecycle.Rules).toHaveLength(1);
      const [rule] = lifecycle.Rules ?? [];
      expect(rule.Status).toBe('Enabled');
      expect(rule.AbortIncompleteMultipartUpload).toEqual({
        DaysAfterInitiation: 2,
      });
    });
  });
});
