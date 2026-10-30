import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMetadata } from './generate-metadata';

describe('generateMetadata (integration)', () => {
  let outputDir: string;

  beforeAll(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'openapi-metadata-'));
    generateMetadata(outputDir);
  }, 120_000);

  afterAll(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('matches the versioned src/metadata.ts (run `npm run openapi:export` after changing DTOs or controllers)', () => {
    const generated = readFileSync(join(outputDir, 'metadata.ts'), 'utf-8');
    const versioned = readFileSync(
      join(__dirname, '..', 'metadata.ts'),
      'utf-8',
    );

    expect(generated).toBe(versioned);
  });

  it('loads modules with require() so ts-node, ts-jest and dist/ all resolve them', () => {
    const generated = readFileSync(join(outputDir, 'metadata.ts'), 'utf-8');

    expect(generated).not.toMatch(/\bimport\("/);
    expect(generated).toContain('require("./videos/dto/create-video.dto")');
  });
});
