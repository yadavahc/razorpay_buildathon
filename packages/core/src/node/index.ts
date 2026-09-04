/**
 * Node-only entry point. Anything that touches the filesystem, the Firebase Admin SDK,
 * or other server-only APIs lives behind this path so the main `@reclaim/core` entry
 * stays safe to import from a browser bundle.
 */
export * from './corpus-io.js';
export * from './firebase-admin.js';
