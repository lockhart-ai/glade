import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  // The sample workspaces the design captures open are made-up files for the app to show, not code of Glade's.
  globalIgnores(['out/', 'dist/', 'release/', 'coverage/', 'docs/', 'scripts/fixtures/*-workspace/']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // The code conventions in CLAUDE.md. `no-explicit-any` and `no-non-null-assertion` come from `strictTypeChecked`.
  {
    rules: {
      // Switch over enums and unions exhaustively, so a new variant fails the lint. A `default` branch doesn't count:
      // it would swallow the new variant silently.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: false },
      ],
      // Fixed sets of values are string enums, with every member's value written out.
      '@typescript-eslint/prefer-enum-initializers': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumMember > :matches(UnaryExpression, Literal[raw=/^[0-9]/])',
          message: 'Use string enums: give every member a string value.',
        },
      ],
      // Data shapes are named interfaces, not type aliases of object literals.
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    },
  },

  // React, for the renderer.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [react.configs.flat.recommended, react.configs.flat['jsx-runtime'], reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    settings: { react: { version: 'detect' } },
  },

  // Plain JavaScript (scripts, this config) isn't in a tsconfig, so it gets the untyped rules only.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // Last, so Prettier owns formatting and no lint rule fights it.
  prettier,
)
