import { generateVideoSlug } from './video-slug.util';

describe('generateVideoSlug', () => {
  it('should return 11 characters from the base64url alphabet', () => {
    // Act
    const slug = generateVideoSlug();

    // Assert
    expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should return distinct values on consecutive calls', () => {
    // Act
    const slugs = Array.from({ length: 1000 }, () => generateVideoSlug());

    // Assert
    expect(new Set(slugs).size).toBe(slugs.length);
    slugs.forEach((slug) => expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/));
  });
});
