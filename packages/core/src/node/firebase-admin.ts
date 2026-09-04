import type { FirebaseConfig } from '../config/index.js';
import { errors } from '../errors/index.js';
import { createFirestoreStore, type FirestoreLike } from '../store/firestore-store.js';
import type { DataStore } from '../store/types.js';

/**
 * Firebase Admin SDK bootstrap.
 *
 * The SDK is loaded with a dynamic import so that `firebase-admin` is only ever resolved
 * when Firestore is actually the configured store. A demo-mode deployment never touches
 * it, and the browser bundle never sees it.
 *
 * Three credential paths are supported, in the order most deployments need them:
 *   1. the Firestore emulator (`FIRESTORE_EMULATOR_HOST`) for local development,
 *   2. an explicit service account (`FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`),
 *   3. Application Default Credentials, which is what Cloud Functions and Cloud Run use.
 */

interface AdminApp {
  name: string;
}

let cachedApp: AdminApp | null = null;
let cachedFirestore: FirestoreLike | null = null;

export async function getFirestore(config: FirebaseConfig): Promise<FirestoreLike> {
  if (cachedFirestore) return cachedFirestore;

  if (!config.projectId) {
    throw errors.config('FIREBASE_PROJECT_ID is required to use the Firestore store');
  }

  const appModule = (await import('firebase-admin/app')) as {
    getApps(): AdminApp[];
    initializeApp(options?: Record<string, unknown>): AdminApp;
    cert(serviceAccount: Record<string, string>): unknown;
    applicationDefault(): unknown;
  };
  const firestoreModule = (await import('firebase-admin/firestore')) as {
    getFirestore(app?: AdminApp): FirestoreLike & {
      settings(options: Record<string, unknown>): void;
    };
  };

  if (!cachedApp) {
    const existing = appModule.getApps();
    if (existing.length > 0 && existing[0]) {
      cachedApp = existing[0];
    } else if (config.emulatorHost) {
      // The emulator ignores credentials entirely; the host env var does the routing.
      cachedApp = appModule.initializeApp({ projectId: config.projectId });
    } else if (config.clientEmail && config.privateKey) {
      cachedApp = appModule.initializeApp({
        credential: appModule.cert({
          projectId: config.projectId,
          clientEmail: config.clientEmail,
          privateKey: config.privateKey,
        }),
        projectId: config.projectId,
      });
    } else {
      cachedApp = appModule.initializeApp({
        credential: appModule.applicationDefault(),
        projectId: config.projectId,
      });
    }
  }

  const db = firestoreModule.getFirestore(cachedApp);
  try {
    // `ignoreUndefinedProperties` is belt-and-braces: the store already strips undefined,
    // but a single missed field would otherwise throw at write time in production.
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if called twice on the same instance; harmless.
  }

  cachedFirestore = db;
  return db;
}

export async function createFirestoreDataStore(
  config: FirebaseConfig,
  namespace?: string,
): Promise<DataStore> {
  const db = await getFirestore(config);
  return createFirestoreStore(namespace ? { db, namespace } : { db });
}

/** Reset the cached app; used by tests and by long-running scripts that reconfigure. */
export function resetFirebaseCache(): void {
  cachedApp = null;
  cachedFirestore = null;
}
