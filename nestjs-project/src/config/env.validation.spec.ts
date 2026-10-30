import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://rustfs:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'streamtube-videos',
};

type EnvValidation = { error?: Error; value: Record<string, unknown> };

const validate = (env: Record<string, string | undefined>): EnvValidation =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as EnvValidation;

describe('envValidationSchema — storage and queue', () => {
  it('should reject a missing S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: undefined });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject a missing S3_BUCKET', () => {
    const { error } = validate({ S3_BUCKET: undefined });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_BUCKET');
  });

  it('should reject an S3_PUBLIC_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_PUBLIC_ENDPOINT: 'not a uri' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_PUBLIC_ENDPOINT');
  });

  it('should apply the Redis and S3 region defaults', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_CORS_ALLOWED_ORIGINS).toBe('*');
  });
});

describe('Jest test environment', () => {
  it('should sign client URLs against the storage host the container reaches', () => {
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe('http://rustfs:9000');
  });
});
