import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'android']),
  {
    // The live-eval runner and build scripts are node scripts (process, fs) —
    // not browser code.
    files: ['evals/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['evals/**', 'supabase/**'],
    extends: [
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // alert/confirm/prompt block the WebView's JS thread until the native
      // dialog answers, and one raised as the activity backgrounds never
      // answers — it froze a recording session with its clock stopped and every
      // control dead. Confirm in the DOM (ModalOverlay + ConfirmButtons).
      'no-alert': 'error',
    },
  },
])
