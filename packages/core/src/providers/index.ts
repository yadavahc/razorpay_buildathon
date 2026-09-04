import type { ReclaimConfig } from '../config/index.js';
import { DemoNotificationProvider, DemoPaymentProvider } from './demo-provider.js';
import type { NotificationProvider, PaymentProvider } from './payment-provider.js';
import { RazorpayProvider } from './razorpay-provider.js';

export * from './payment-provider.js';
export * from './demo-provider.js';
export * from './razorpay-provider.js';

/**
 * Resolve the payment provider from configuration. `RECLAIM_MODE` chooses; nothing else
 * in the codebase branches on the mode.
 */
export function createPaymentProvider(config: ReclaimConfig): PaymentProvider {
  if (config.mode === 'razorpay_test') return new RazorpayProvider(config.razorpay);
  return new DemoPaymentProvider();
}

/**
 * Messaging always runs through the offline provider. RECLAIM operates on synthetic
 * customer records, and dispatching real email or SMS to synthetic addresses would be
 * both useless and irresponsible. Messages are rendered in full and stored, so the
 * content is inspectable in the UI.
 */
export function createNotificationProvider(_config: ReclaimConfig): NotificationProvider {
  return new DemoNotificationProvider();
}
