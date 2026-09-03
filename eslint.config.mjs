import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/generated/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/dev-dist/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // TypeScript ya valida nombres no definidos (variables Y tipos, ej. `NodeJS.ProcessEnv`)
      // de forma más precisa que esta regla de ESLint -- recomendación estándar de typescript-eslint.
      'no-undef': 'off',
    },
  },
  {
    // Backend / paquetes de Node: apps/api y packages/*.
    files: ['apps/api/**/*.ts', 'packages/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Frontends (Vite + navegador): apps/admin-web y apps/shop-pwa.
    files: [
      'apps/admin-web/**/*.{ts,tsx}',
      'apps/shop-pwa/**/*.{ts,tsx}',
      'packages/auth-client/**/*.{ts,tsx}',
    ],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Scripts de desarrollo de las apps Vite (vite.config.ts, etc.) siguen corriendo en Node.
    files: ['apps/admin-web/*.config.{ts,js}', 'apps/shop-pwa/*.config.{ts,js}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Scripts de CLI (seed): console.log es la salida esperada, no un descuido.
    files: ['packages/db/src/seed.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettierConfig,
];
