import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const testStorageConfig = {
  endpoint: 'http://storage-internal.test:9000',
  publicEndpoint: 'http://storage-public.test:9100',
  region: 'us-east-1',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'test-bucket',
  corsAllowedOrigins: ['http://app.test'],
};

describe('StorageModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    // compile() does not run onModuleInit, so no request reaches the storage.
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(testStorageConfig)
      .compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('should compile and expose StorageService', () => {
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
  });

  it('should sign public read URLs with the public endpoint host', async () => {
    const service = module.get(StorageService);

    const url = new URL(
      await service.signGetUrl('videos/abc/source', {
        expiresIn: 60,
        client: 'public',
      }),
    );

    expect(url.host).toBe(new URL(testStorageConfig.publicEndpoint).host);
    expect(url.pathname).toBe(`/${testStorageConfig.bucket}/videos/abc/source`);
  });

  it('should sign internal read URLs with the internal endpoint host', async () => {
    const service = module.get(StorageService);

    const url = new URL(
      await service.signGetUrl('videos/abc/source', {
        expiresIn: 60,
        client: 'internal',
      }),
    );

    expect(url.host).toBe(new URL(testStorageConfig.endpoint).host);
  });

  it('should sign upload part URLs with the public endpoint host', async () => {
    const service = module.get(StorageService);

    const url = new URL(
      await service.signUploadPartUrl('videos/abc/source', 'upload-1', 3, 60),
    );

    expect(url.host).toBe(new URL(testStorageConfig.publicEndpoint).host);
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('upload-1');
  });
});
