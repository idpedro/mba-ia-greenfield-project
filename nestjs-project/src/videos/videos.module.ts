import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing';
import { Video } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoUploadService } from './video-upload.service';
import { VideoPresenter } from './video.presenter';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [
    VideoUploadService,
    VideoPresenter,
    VideosService,
    VideoDeliveryService,
  ],
})
export class VideosModule {}
