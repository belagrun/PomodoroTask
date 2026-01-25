module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2020: true
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint', 'obsidian'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  rules: {
    // Obsidian plugin does not ship a preset; enable its rules explicitly
    'obsidian/unresolved-provider-dependencies': 'error',
    'obsidian/no-circular-dependencies': 'error',
    'obsidian/strongly-typed-inject-component': 'error',
    '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-ignore': 'allow-with-description' }],
    '@typescript-eslint/no-inferrable-types': 'off'
  }
};
