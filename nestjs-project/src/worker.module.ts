import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configModuleOptions } from './config/config-module.options';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage';
import { VideoProcessingModule } from './video-processing';

// Root module of the `video-worker` process: no HTTP layer, only the
// infrastructure the queue consumers need.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    DatabaseModule,
    QueueModule,
    StorageModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
