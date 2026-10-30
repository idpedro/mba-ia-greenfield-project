// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Module boundaries (phase-03-videos/TD-10): `storage` and `video-processing`
// are consumed only through their public `index.ts`, never by deep imports.
const boundaryPattern = (moduleName) => ({
  group: [`**/${moduleName}/*`, `!**/${moduleName}/index`],
  message: `Import from the '${moduleName}' module's public index (e.g. '../${moduleName}'), not from its internal files.`,
});
const STORAGE_BOUNDARY = boundaryPattern('storage');
const VIDEO_PROCESSING_BOUNDARY = boundaryPattern('video-processing');

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // Each module may import its own files; the rule options of the most
  // specific block win, so every block lists the boundaries that still apply.
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [STORAGE_BOUNDARY, VIDEO_PROCESSING_BOUNDARY] },
      ],
    },
  },
  {
    files: ['src/storage/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [VIDEO_PROCESSING_BOUNDARY] },
      ],
    },
  },
  {
    files: ['src/video-processing/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [STORAGE_BOUNDARY] }],
    },
  },
);
