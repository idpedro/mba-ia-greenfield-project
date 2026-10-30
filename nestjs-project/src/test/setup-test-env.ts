// Loaded before `dotenv/config`, which never overrides variables already set.
// Tests run inside the container, where `localhost:9000` is not the storage:
// presigned URLs must be signed for a host the container reaches (SigV4 signs
// the host, so it cannot be rewritten after signing).
process.env.S3_PUBLIC_ENDPOINT = 'http://rustfs:9000';
