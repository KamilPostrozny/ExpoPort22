// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier/flat');

module.exports = defineConfig([
  {
    ignores: [
      'dist/**',
      'web-build/**',
      'android/**',
      'ios/**',
      '.expo/**',
      '.pi/**',
      'modules/*/android/build/**',
      'src/themes-generated.ts',
    ],
  },
  expoConfig,
  prettierConfig,
]);
