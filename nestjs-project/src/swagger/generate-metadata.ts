import { PluginMetadataGenerator } from '@nestjs/cli/lib/compiler/plugins/plugin-metadata-generator';
import { ReadonlyVisitor } from '@nestjs/swagger/dist/plugin';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface NestCliPlugin {
  name: string;
  options?: Record<string, unknown>;
}

const PROJECT_ROOT = join(__dirname, '..', '..');
const SOURCE_ROOT = join(PROJECT_ROOT, 'src');
const METADATA_FILENAME = 'metadata.ts';

// The generator type-checks the whole project (including the previous
// metadata.ts) and does not rewrite the file when there are errors, so a stale
// file pointing to a removed DTO would block regeneration. Start from an empty
// module instead.
const EMPTY_METADATA = 'export default async () => ({});\n';

// The printer emits `import("./x")`. Under `module: nodenext` (CommonJS
// output) TypeScript keeps dynamic import() as a native ESM import, which
// fails under ts-node and Jest (no .js files next to the sources). require()
// resolves the module in all three runtimes: ts-node, ts-jest and dist/.
const RELATIVE_DYNAMIC_IMPORT = /\bimport\(("\.{1,2}\/[^"]+")\)/g;

// Reads the @nestjs/swagger plugin options from nest-cli.json so the
// generated metadata matches what `nest build` / `start:dev` inject.
function readSwaggerPluginOptions(): Record<string, unknown> {
  const nestCli = JSON.parse(
    readFileSync(join(PROJECT_ROOT, 'nest-cli.json'), 'utf-8'),
  ) as { compilerOptions?: { plugins?: NestCliPlugin[] } };
  const plugin = nestCli.compilerOptions?.plugins?.find(
    (p) => p.name === '@nestjs/swagger',
  );
  return plugin?.options ?? {};
}

// Generates src/metadata.ts, consumed by SwaggerModule.loadPluginMetadata in
// buildSwaggerDocument so that ts-node (openapi:export) and ts-jest produce the
// same document as the plugin-compiled server. Import paths are always
// relative to src/, whatever `outputDir` is.
export function generateMetadata(outputDir = SOURCE_ROOT): void {
  const metadataPath = join(outputDir, METADATA_FILENAME);
  writeFileSync(metadataPath, EMPTY_METADATA);
  new PluginMetadataGenerator().generate({
    visitors: [
      new ReadonlyVisitor({
        ...readSwaggerPluginOptions(),
        pathToSource: SOURCE_ROOT,
      }),
    ],
    outputDir,
    filename: METADATA_FILENAME,
    // Resolved by the Nest CLI relative to process.cwd() (project root).
    tsconfigPath: 'tsconfig.build.json',
  });

  const generated = readFileSync(metadataPath, 'utf-8');
  writeFileSync(
    metadataPath,
    generated.replace(RELATIVE_DYNAMIC_IMPORT, 'Promise.resolve(require($1))'),
  );
}

if (require.main === module) {
  generateMetadata();
}
