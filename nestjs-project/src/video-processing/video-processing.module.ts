import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage';
import { UsersModule } from '../users/users.module';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg/ffmpeg.service';
import { StaleUploadSweepProcessor } from './stale-upload-sweep.processor';
import { StaleUploadSweepScheduler } from './stale-upload-sweep.scheduler';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';

// Consumers of the video queues. Imported only by WorkerModule, so the API
// process produces jobs but never processes them (TD-10).
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // Registers User and, through ChannelsModule, Channel: the entities Video
    // relates to, which autoLoadEntities needs to build Video's metadata.
    UsersModule,
    StorageModule,
    // The processors' BullMQ workers take their connection and prefix from
    // here; the maintenance queue also carries the sweep's job scheduler.
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: VIDEO_MAINTENANCE_QUEUE },
    ),
  ],
  // Not exported: only the worker-side consumers use them.
  providers: [
    FfmpegService,
    VideoProcessingProcessor,
    StaleUploadSweepProcessor,
    StaleUploadSweepScheduler,
  ],
})
export class VideoProcessingModule {}
