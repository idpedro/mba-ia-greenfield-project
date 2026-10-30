import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing';
import { Video } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoUploadService } from './video-upload.service';
import { VideoPresenter } from './video.presenter';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    // compile() does not run onModuleInit, so the bucket bootstrap is skipped.
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        QueueModule,
        VideosModule,
      ],
    }).compile();
  }, 30000);

  afterAll(async () => {
    await module.close();
  });

  it('should compile and resolve the controller and its providers', () => {
    expect(module.get(VideosController)).toBeInstanceOf(VideosController);
    expect(module.get(VideoUploadService)).toBeInstanceOf(VideoUploadService);
    expect(module.get(VideoPresenter)).toBeInstanceOf(VideoPresenter);
    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    expect(module.get(VideoDeliveryService)).toBeInstanceOf(
      VideoDeliveryService,
    );
  });

  it('should register the video-processing queue', () => {
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
  });
});
