// Presigned URLs carry a credential and a signature in the query string that
// stay valid until they expire, so they must never reach error messages or
// logs.

const URL_QUERY_PATTERN = /(\bhttps?:\/\/[^\s?#'"]+)[?#][^\s'"]*/gi;
const SIGV4_PARAM_PATTERN = /(X-Amz-[A-Za-z-]+)=[^\s&'"]*/gi;

/** Reduces a URL to `origin + pathname`, dropping query string and fragment. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0];
  }
}

/**
 * Removes presigned query strings from free text (e.g. ffmpeg stderr): every
 * occurrence of `url`, the query string of any other http(s) URL, and any
 * loose `X-Amz-*=` parameter value.
 */
export function redactPresignedUrls(text: string, url?: string): string {
  let redacted = url ? text.split(url).join(redactUrl(url)) : text;
  redacted = redacted.replace(URL_QUERY_PATTERN, '$1');
  return redacted.replace(SIGV4_PARAM_PATTERN, '$1=[REDACTED]');
}
