import type { CaseProfile } from '../domain/case-profiles.js';
import { formatMinor } from '../types/money.js';

/**
 * Customer-facing message copy.
 *
 * The text is generated from the failure taxonomy, not from a language model. A message
 * that goes to a real customer about a real declined payment has to say the right thing
 * every single time, and a template that names the actual blocker — "your card expired",
 * not "something went wrong" — is what converts. Templates are deterministic, reviewable,
 * and testable; that combination matters more here than novelty.
 *
 * Every message is stored in full on the notification record, so an operator can read
 * exactly what a customer was told.
 */

export interface RenderNotificationInput {
  kind: 'payment_link' | 'customer_notification';
  customerName: string;
  amountMinor: number;
  profile: CaseProfile;
  linkUrl: string | null;
  merchantName: string;
}

export interface RenderedNotification {
  template: string;
  subject: string;
  body: string;
}

/** What the customer is being asked to do, phrased per failure category. */
function callToAction(profile: CaseProfile, linkUrl: string | null): string {
  if (linkUrl) {
    switch (profile.category) {
      case 'instrument':
        return `You can complete it with a different card or UPI here: ${linkUrl}`;
      case 'funding':
        return `Once there are funds available, you can complete the payment here: ${linkUrl}`;
      case 'authentication':
        return `You can finish the authentication step here: ${linkUrl}`;
      case 'mandate':
        return `You can re-authorise the payment here: ${linkUrl}`;
      default:
        return `You can complete the payment here: ${linkUrl}`;
    }
  }

  switch (profile.category) {
    case 'instrument':
      return 'Updating your saved payment method will let the next attempt go through.';
    case 'funding':
      return 'We will try again automatically once the account has sufficient balance.';
    case 'authentication':
      return 'The next attempt will ask you to confirm with your bank.';
    case 'infrastructure':
      return 'This was a temporary issue on the payment network, and we will retry it for you shortly.';
    case 'risk':
      return 'Your bank may ask you to approve the transaction before it can go through.';
    case 'mandate':
      return 'Your recurring payment authorisation needs to be set up again before we can bill you.';
    default:
      return 'You can complete the payment whenever you are ready.';
  }
}

/** A plain-language account of the failure, one sentence, no jargon. */
function reasonSentence(profile: CaseProfile): string {
  switch (profile.key) {
    case 'insufficient_funds':
      return 'the account did not have enough balance when we tried to charge it';
    case 'card_expired':
      return 'the card we have on file has expired';
    case 'incorrect_cvv':
      return 'the security code did not match the card';
    case 'card_blocked':
      return 'the card has been blocked by the issuing bank';
    case 'mandate_revoked':
      return 'the recurring payment authorisation is no longer active';
    case 'bank_downtime':
      return 'your bank was temporarily unavailable';
    case 'payment_timeout':
    case 'gateway_error':
    case 'network_error':
      return 'the payment network did not respond in time';
    case 'authentication_failed':
      return 'the additional verification step was not completed';
    case 'daily_limit_exceeded':
      return 'the transaction went over a daily limit on the account';
    case 'upi_collect_expired':
      return 'the UPI request expired before it was approved';
    case 'international_not_allowed':
      return 'the card is not enabled for international payments';
    case 'wallet_insufficient_balance':
      return 'the wallet balance was too low to cover the amount';
    case 'risk_declined_by_bank':
      return 'your bank declined the transaction as a precaution';
    case 'invalid_account':
      return 'the account details on file could not be verified';
    case 'do_not_honour':
      return 'your bank declined the transaction without giving a reason';
    default:
      if (profile.key.startsWith('abandoned')) return 'the checkout was not completed';
      if (profile.key.startsWith('overdue')) return 'the invoice is past its due date';
      return 'the payment could not be completed';
  }
}

export function renderNotification(input: RenderNotificationInput): RenderedNotification {
  const amount = formatMinor(input.amountMinor, { whole: true });
  const firstName = input.customerName.split(' ')[0] ?? input.customerName;
  const reason = reasonSentence(input.profile);
  const action = callToAction(input.profile, input.linkUrl);

  const isOverdue = input.profile.key.startsWith('overdue');
  const isAbandoned = input.profile.key.startsWith('abandoned');

  const subject = isOverdue
    ? `Your ${amount} invoice is past due`
    : isAbandoned
      ? `You left ${amount} in your cart`
      : `Your ${amount} payment did not go through`;

  const opening = isOverdue
    ? `Hi ${firstName}, your invoice for ${amount} is past its due date.`
    : isAbandoned
      ? `Hi ${firstName}, you were partway through a ${amount} payment and did not finish.`
      : `Hi ${firstName}, we could not process your payment of ${amount} because ${reason}.`;

  const body = [
    opening,
    action,
    input.profile.customerActionRequired
      ? 'If you have already sorted this out, you can ignore this message.'
      : 'No action is needed from you right now.',
    '— Sent by RECLAIM on behalf of the merchant. This is a demonstration message generated from synthetic data.',
  ].join('\n\n');

  return {
    template: `${input.kind}:${input.profile.category}`,
    subject,
    body,
  };
}
