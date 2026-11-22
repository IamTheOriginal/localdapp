import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Relax rules too noisy for this codebase
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'no-empty': 'warn',
    },
  },
  {
    // src/headless/controlDapp/ is a Code App content bundle (classic browser scripts), not project code.
    ignores: ['node_modules/', 'dist/', 'mcp-server/', '.heroui-docs/', '*.config.*', 'src/headless/controlDapp/'],
  },
);