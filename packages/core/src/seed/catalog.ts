/** Reference data for the synthetic corpus: names, banks, plans, geography. */

export const FIRST_NAMES = [
  'Aarav', 'Aditi', 'Advait', 'Ananya', 'Arjun', 'Anika', 'Aryan', 'Avni',
  'Dev', 'Diya', 'Farhan', 'Gauri', 'Harsh', 'Ishaan', 'Ishita', 'Kabir',
  'Kavya', 'Krishna', 'Lakshmi', 'Manav', 'Meera', 'Mihir', 'Naina', 'Neel',
  'Nikhil', 'Pooja', 'Pranav', 'Priya', 'Rahul', 'Rhea', 'Riya', 'Rohan',
  'Sahil', 'Saanvi', 'Sameer', 'Sanya', 'Shreya', 'Siddharth', 'Tanvi', 'Tara',
  'Uday', 'Vaishnavi', 'Varun', 'Vihaan', 'Yash', 'Zara', 'Kiran', 'Nandini',
  'Rajat', 'Sneha', 'Imran', 'Fatima', 'Joseph', 'Grace', 'Thomas', 'Anjali',
] as const;

export const LAST_NAMES = [
  'Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Menon', 'Gupta',
  'Singh', 'Kaur', 'Das', 'Bose', 'Chatterjee', 'Mukherjee', 'Rao', 'Naidu',
  'Pillai', 'Joshi', 'Desai', 'Shah', 'Mehta', 'Kulkarni', 'Deshpande', 'Bhat',
  'Kapoor', 'Malhotra', 'Chopra', 'Ahuja', 'Bansal', 'Agarwal', 'Jain', 'Shetty',
  'Fernandes', 'Dsouza', 'Khan', 'Ansari', 'Sheikh', 'Mathew', 'Varghese', 'Thomas',
] as const;

export const COMPANY_PREFIXES = [
  'Nimbus', 'Vertex', 'Kadamba', 'Sable', 'Orbit', 'Lumen', 'Quanta', 'Meridian',
  'Praxis', 'Sanchay', 'Northwind', 'Tessera', 'Aurum', 'Halcyon', 'Vantage', 'Cobalt',
] as const;

export const COMPANY_SUFFIXES = [
  'Labs', 'Systems', 'Technologies', 'Retail', 'Logistics', 'Health', 'Financial', 'Media',
] as const;

/** Card issuers and net-banking partners, with realistic market share weights. */
export const CARD_ISSUERS: ReadonlyArray<readonly [string, number]> = [
  ['HDFC Bank', 22],
  ['ICICI Bank', 18],
  ['State Bank of India', 16],
  ['Axis Bank', 12],
  ['Kotak Mahindra Bank', 8],
  ['IndusInd Bank', 5],
  ['Yes Bank', 4],
  ['IDFC First Bank', 4],
  ['Punjab National Bank', 4],
  ['Bank of Baroda', 3],
  ['Federal Bank', 2],
  ['RBL Bank', 2],
];

export const UPI_HANDLES: ReadonlyArray<readonly [string, number]> = [
  ['PhonePe', 34],
  ['Google Pay', 30],
  ['Paytm', 15],
  ['Amazon Pay', 8],
  ['BHIM', 5],
  ['CRED', 4],
  ['Navi', 4],
];

export const WALLETS: ReadonlyArray<readonly [string, number]> = [
  ['Paytm Wallet', 40],
  ['Amazon Pay Balance', 25],
  ['PhonePe Wallet', 20],
  ['Mobikwik', 15],
];

export const CARD_NETWORKS: ReadonlyArray<readonly [string, number]> = [
  ['Visa', 40],
  ['Mastercard', 32],
  ['RuPay', 22],
  ['Amex', 6],
];

export interface PlanDefinition {
  id: string;
  name: string;
  amountMinor: number;
  interval: 'monthly' | 'quarterly' | 'annual';
  weight: number;
}

export const PLANS: readonly PlanDefinition[] = [
  { id: 'plan_starter_m', name: 'Starter Monthly', amountMinor: 49_900, interval: 'monthly', weight: 28 },
  { id: 'plan_growth_m', name: 'Growth Monthly', amountMinor: 199_900, interval: 'monthly', weight: 24 },
  { id: 'plan_pro_m', name: 'Pro Monthly', amountMinor: 499_900, interval: 'monthly', weight: 14 },
  { id: 'plan_growth_q', name: 'Growth Quarterly', amountMinor: 539_900, interval: 'quarterly', weight: 10 },
  { id: 'plan_business_m', name: 'Business Monthly', amountMinor: 1_299_900, interval: 'monthly', weight: 8 },
  { id: 'plan_pro_a', name: 'Pro Annual', amountMinor: 4_999_000, interval: 'annual', weight: 7 },
  { id: 'plan_enterprise_a', name: 'Enterprise Annual', amountMinor: 24_000_000, interval: 'annual', weight: 5 },
  { id: 'plan_lite_m', name: 'Lite Monthly', amountMinor: 19_900, interval: 'monthly', weight: 4 },
];

/** IANA zones, weighted so most customers sit in IST but quiet-hours logic still varies. */
export const TIMEZONES: ReadonlyArray<readonly [string, number]> = [
  ['Asia/Kolkata', 88],
  ['Asia/Dubai', 4],
  ['Europe/London', 3],
  ['America/New_York', 3],
  ['Asia/Singapore', 2],
];

export const EMAIL_DOMAINS: ReadonlyArray<readonly [string, number]> = [
  ['gmail.com', 46],
  ['outlook.com', 14],
  ['yahoo.in', 9],
  ['hotmail.com', 6],
  ['proton.me', 4],
];
