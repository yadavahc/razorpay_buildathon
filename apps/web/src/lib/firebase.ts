'use client';

import { type FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import {
  type Auth,
  type User,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';

/**
 * Firebase client SDK — authentication only.
 *
 * The browser never reads Firestore directly, even though the security rules permit
 * scoped reads. Every figure in the product comes from a route handler that ran the same
 * analytics code the tests assert on; a second read path would be a second place for the
 * numbers to diverge.
 *
 * The web API key here is a public identifier rather than a secret — access is controlled
 * by the security rules in `firestore.rules`, not by key secrecy. It still lives in
 * environment variables so a deployment can point at its own project without a code change.
 */

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

/** True when a project has been configured. The app runs fine without one. */
export const isFirebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId);

let cachedApp: FirebaseApp | null = null;

export function getFirebaseApp(): FirebaseApp | null {
  if (!isFirebaseConfigured) return null;
  if (cachedApp) return cachedApp;

  cachedApp = getApps().length > 0 ? getApp() : initializeApp(config as Record<string, string>);
  return cachedApp;
}

export function getFirebaseAuth(): Auth | null {
  const app = getFirebaseApp();
  return app ? getAuth(app) : null;
}

/**
 * Subscribe to auth state. Returns a no-op unsubscribe when Firebase is not configured,
 * so callers never need to branch on whether it is.
 */
export function watchAuth(callback: (user: User | null) => void): () => void {
  const auth = getFirebaseAuth();
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

export async function signIn(email: string, password: string): Promise<User> {
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error(
      'Firebase is not configured. Set the NEXT_PUBLIC_FIREBASE_* variables to enable sign-in.',
    );
  }
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function signOut(): Promise<void> {
  const auth = getFirebaseAuth();
  if (auth) await firebaseSignOut(auth);
}

/**
 * The merchant a signed-in user belongs to, read from their custom claim.
 *
 * The claim is the authority rather than a `users` document lookup: the security rules
 * read the same claim, and resolving the merchant two different ways would let the two
 * disagree during the window before a claim propagates.
 */
export async function getMerchantIdFromClaims(user: User): Promise<string | null> {
  const token = await user.getIdTokenResult();
  const merchantId = token.claims.merchantId;
  return typeof merchantId === 'string' ? merchantId : null;
}
