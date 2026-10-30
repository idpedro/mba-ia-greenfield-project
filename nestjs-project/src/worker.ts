import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM runs the shutdown hooks, which close the BullMQ workers so an
  // active job is not dropped mid-flight.
  app.enableShutdownHooks();
  new Logger('Worker').log('Video worker started');
}
void bootstrap();
