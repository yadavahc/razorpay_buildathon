// `@next/env` is CommonJS, so it must be imported via its default export.
import nextEnv from '@next/env';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment lives once, at the repository root, so the CLI scripts and the web app read
 * exactly the same configuration. Next only looks in its own project directory by
 * default, so we point it at the root explicitly. This runs during config evaluation,
 * which is early enough for NEXT_PUBLIC_* values to be inlined at build time.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// `forceReload` matters: Next initialises @next/env against its own project directory
// (apps/web, which has no .env files) before it evaluates this config, and a second call
// without the flag returns that cached — empty — result instead of reading the root.
nextEnv.loadEnvConfig(repoRoot, undefined, undefined, true);

/**
 * A relative `GOOGLE_APPLICATION_CREDENTIALS` in the root .env is relative to the
 * repository, but Next runs with its cwd set to `apps/web` — so the Google auth library
 * would look for the key one directory too deep and silently fall back to no credentials.
 * Resolve it here, where the repo root is known.
 */
const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credentials && !isAbsolute(credentials)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(repoRoot, credentials);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // `@reclaim/core` ships TypeScript source rather than a build artifact, so the whole
  // monorepo typechecks as one unit and there is no build step between editing a domain
  // rule and seeing it in the UI.
  transpilePackages: ['@reclaim/core'],

  // The Admin SDK is server-only and must never be traced into a client bundle.
  serverExternalPackages: ['firebase-admin'],

  eslint: {
    dirs: ['src'],
  },

  /**
   * The core package uses NodeNext module resolution, so its internal imports carry
   * explicit `.js` extensions — which is correct ESM, and what lets the same source run
   * under `tsx` in the CLI scripts and under `tsc` in the Cloud Functions build.
   *
   * Bundlers need to be told that a `.js` specifier may resolve to a `.ts` file. Without
   * this alias, every internal import inside `@reclaim/core` fails to resolve.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  // The same rule for Turbopack, so `next dev --turbopack` behaves identically.
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
};

export default nextConfig;
