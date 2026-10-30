import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Reached by the API and the worker over the Compose network.
  endpoint: process.env.S3_ENDPOINT || 'http://rustfs:9000',
  // Host the browser sees; presigned URLs handed to clients are signed against it.
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  bucket: process.env.S3_BUCKET || '',
  corsAllowedOrigins: (process.env.S3_CORS_ALLOWED_ORIGINS || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
}));
