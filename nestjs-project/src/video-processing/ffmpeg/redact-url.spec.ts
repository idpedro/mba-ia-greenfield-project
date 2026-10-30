import { redactPresignedUrls, redactUrl } from './redact-url';

const SIGNED_URL =
  'http://rustfs:9000/streamtube/videos/id/original' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261030%2Fus-east-1%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20261030T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=deadbeefcafe';
const BARE_URL = 'http://rustfs:9000/streamtube/videos/id/original';

describe('redactUrl', () => {
  it('should keep only origin and pathname', () => {
    expect(redactUrl(SIGNED_URL)).toBe(BARE_URL);
  });

  it('should drop the fragment too', () => {
    expect(redactUrl(`${BARE_URL}#frag`)).toBe(BARE_URL);
  });

  it('should strip the query string of an unparsable URL', () => {
    expect(redactUrl('not a url?X-Amz-Signature=abc')).toBe('not a url');
  });
});

describe('redactPresignedUrls', () => {
  it('should replace every occurrence of the given URL with its redacted form', () => {
    const text = `${SIGNED_URL}: Invalid data\nretry ${SIGNED_URL}`;

    expect(redactPresignedUrls(text, SIGNED_URL)).toBe(
      `${BARE_URL}: Invalid data\nretry ${BARE_URL}`,
    );
  });

  it('should drop the query string of other http(s) URLs in the text', () => {
    const text = 'Redirected to https://other:9000/b/k?X-Amz-Signature=abc now';

    expect(redactPresignedUrls(text)).toBe(
      'Redirected to https://other:9000/b/k now',
    );
  });

  it('should mask loose X-Amz-* parameters', () => {
    const text = 'query: X-Amz-Credential=AKIA%2Fx&X-Amz-Signature=abc123';

    const redacted = redactPresignedUrls(text);

    expect(redacted).toBe(
      'query: X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]',
    );
  });

  it('should leave text without URLs untouched', () => {
    expect(redactPresignedUrls('Invalid data found', SIGNED_URL)).toBe(
      'Invalid data found',
    );
  });
});
