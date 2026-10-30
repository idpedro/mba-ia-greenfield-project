import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import databaseConfig from '../config/database.config';
import { DatabaseModule } from './database.module';

describe('DatabaseModule (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
        DatabaseModule,
      ],
    }).compile();
    await module.init();
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should open a connection to the db service', async () => {
    expect(dataSource.isInitialized).toBe(true);
    await expect(dataSource.query('SELECT 1 AS ok')).resolves.toEqual([
      { ok: 1 },
    ]);
  });

  it('should take the connection parameters from databaseConfig', () => {
    const config = module.get<ReturnType<typeof databaseConfig>>(
      databaseConfig.KEY,
    );
    const options = dataSource.options as PostgresConnectionOptions;

    expect(options).toMatchObject({
      type: 'postgres',
      host: config.host,
      port: config.port,
      username: config.username,
      database: config.name,
    });
  });

  it('should never synchronize the schema', () => {
    expect(dataSource.options.synchronize).toBe(false);
  });
});
