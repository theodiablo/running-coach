import js from '@eslint/js'
import json from '@eslint/json'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { builtinRules } from 'eslint/use-at-your-own-risk'
import local from './eslint-rules/index.js'

// Each restriction is its own named rule (an alias of a core rule) so it can be
// switched off for the one file that owns the seam without lifting the others.
const syntax = builtinRules.get('no-restricted-syntax')
const props = builtinRules.get('no-restricted-properties')
const imports = builtinRules.get('no-restricted-imports')
const seams = {
  meta: { name: 'seams' },
  rules: {
    'gps-through-geo-source': props,
    'tiles-through-cache': props,
    'telemetry-sdk': syntax,
    'no-native-in-ui': syntax,
    'keep-awake-hook': syntax,
    'css-only-animations': imports,
    'goal-from-settings': syntax,
    'best-efforts-through-helpers': syntax,
    'no-regex-lookbehind': syntax,
    'npm-specifiers': syntax,
  },
}

const importOf = (re, message) => [
  { selector: `ImportDeclaration[source.value=${re}]`, message },
  { selector: `ImportExpression[source.value=${re}]`, message },
]

const COMMENTS = ['error', { max: 4 }]
const TESTS = ['**/*.test.{ts,tsx,mjs}']

export default defineConfig([
  globalIgnores(['dist', 'android', 'ios']),
  {
    files: ['evals/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'eslint-rules/**/*.js', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['evals/**', 'supabase/**', 'infra/functions/**'],
    extends: [
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: { local, seams },
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-alert': ['error'],
      'local/max-comment-lines': COMMENTS,
      'local/supabase-check-error': 'error',
      'local/dynamic-import-catch': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: TESTS,
    plugins: { local, seams },
    rules: {
      'seams/no-regex-lookbehind': ['error', {
        selector: 'Literal[regex.pattern=/\\(\\?<[=!]/]',
        message: 'No regex lookbehind: JavaScriptCore before iOS 16.4 cannot parse the module, and iOS 15.4 is the floor.',
      }],
      'local/build-plan-style': 'error',
      'local/modal-dismissable': 'error',
      'local/no-parse-or-zero-in-onchange': 'error',
      'local/no-summed-haversine': 'error',
      'local/hr-samples-through-expand': 'error',
      'seams/gps-through-geo-source': ['error', {
        object: 'navigator', property: 'geolocation',
        message: 'All GPS goes through geoSource (src/geo/source.ts) behind useRunTracker.',
      }],
      'seams/tiles-through-cache': ['error', {
        object: 'L', property: 'tileLayer',
        message: 'Use cachedTileLayer (or uncachedTileLayer on /watch/): a bare tile layer leaves the map blank offline.',
      }],
      'seams/telemetry-sdk': ['error', ...importOf('/^posthog/',
        'Only src/telemetry/posthog.ts imports the SDK; everything else goes through src/telemetry/index.ts.')],
      'seams/keep-awake-hook': ['error', ...importOf('/keep-awake/',
        'Hold the screen on only through useKeepAwake, and never from a recorder.')],
      'seams/css-only-animations': ['error', {
        patterns: [{
          group: ['framer-motion', 'motion', 'motion/*', 'react-spring', '@react-spring/*', 'gsap', 'animejs'],
          message: 'Animations are CSS-only: keyframes + --animate-* tokens in src/index.css.',
        }],
      }],
      'seams/goal-from-settings': ['error', {
        selector: 'MemberExpression[property.name="goalSec"][object.name="plan"]',
        message: 'The goal is settings.goalSec: buildPlan substitutes 7200 for an empty one in plan.goalSec.',
      }],
      'seams/best-efforts-through-helpers': ['error', {
        selector: 'MemberExpression[property.name="bestEfforts"]',
        message: 'Read best efforts through effortsFor / rankRunEfforts (src/utils/bestEfforts.ts): they fill the estimate and keep walks and OTHER out.',
      }],
    },
  },
  {
    files: ['src/views/**/*.tsx', 'src/modals/**/*.tsx', 'src/components/**/*.tsx'],
    ignores: TESTS,
    plugins: { seams },
    rules: {
      'seams/no-native-in-ui': ['error', ...importOf('/^(?!@capacitor\\/browser$).*capacitor/',
        'UI code never touches a native bridge: go through the seam (geoSource, getHrSource, src/imports/, src/native.ts).')],
    },
  },
  { files: ['src/geo/**'], rules: { 'seams/gps-through-geo-source': 'off' } },
  { files: ['src/components/cachedTileLayer.ts'], rules: { 'seams/tiles-through-cache': 'off' } },
  { files: ['src/telemetry/posthog.ts'], rules: { 'seams/telemetry-sdk': 'off' } },
  { files: ['src/hooks/useKeepAwake.ts'], rules: { 'seams/keep-awake-hook': 'off' } },
  { files: ['src/utils/plan.ts'], rules: { 'seams/goal-from-settings': 'off' } },
  { files: ['src/utils/bestEfforts.ts', 'src/bestEffortsBackfill.ts'], rules: { 'seams/best-efforts-through-helpers': 'off' } },
  { files: ['src/utils/geo.ts'], rules: { 'local/no-summed-haversine': 'off' } },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { local },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'local/forbid-file': ['error', 'App source is TypeScript: rename to .ts, or .tsx if it contains JSX.'] },
  },
  {
    // Edge functions are Deno: only the project rules, no browser config.
    files: ['supabase/functions/**/*.{ts,mjs}'],
    plugins: { local, seams },
    languageOptions: { parser: tseslint.parser },
    rules: {
      'local/max-comment-lines': COMMENTS,
      'local/supabase-check-error': 'error',
      'seams/npm-specifiers': ['error', ...importOf('/^https?:/',
        'Import with an npm: specifier: the sandbox egress blocks esm.sh and deno.land, and each function has its own deno.json.')],
    },
  },
  {
    files: ['src/i18n/locales/{fr,es}/*.json', 'src/marketing/marketing.{fr,es}.json'],
    plugins: { json, local },
    language: 'json/json',
    rules: { 'local/no-em-dash-json': 'error' },
  },
])
