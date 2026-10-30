import { ParseVideoSlugPipe } from './parse-video-slug.pipe';
import { VideoNotFoundException } from './video.exceptions';
import { generateVideoSlug } from './video-slug.util';

describe('ParseVideoSlugPipe', () => {
  const pipe = new ParseVideoSlugPipe();

  it('should return a generated slug unchanged', () => {
    // Arrange
    const slug = generateVideoSlug();

    // Act & Assert
    expect(pipe.transform(slug)).toBe(slug);
  });

  it('should accept every base64url character', () => {
    expect(pipe.transform('aZ09-_aZ09-')).toBe('aZ09-_aZ09-');
  });

  it.each([
    ['too short', 'curto'],
    ['too long', 'abcdefghijkl'],
    ['empty', ''],
    ['outside the base64url alphabet', 'abc+def/ghi'],
    ['with padding', 'abcdefghij='],
  ])('should throw not-found for a slug %s', (_case, slug) => {
    expect(() => pipe.transform(slug)).toThrow(VideoNotFoundException);
  });
});
