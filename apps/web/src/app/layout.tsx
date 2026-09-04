import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'RECLAIM — Autonomous Revenue Recovery Infrastructure',
    template: '%s · RECLAIM',
  },
  description:
    'RECLAIM finds the revenue slipping away, decides what can actually be recovered, chooses the safest economically valuable intervention, executes it under deterministic guardrails, and proves how much money came back.',
  applicationName: 'RECLAIM',
  authors: [{ name: 'RECLAIM' }],
  keywords: [
    'revenue recovery',
    'payment failures',
    'dunning',
    'checkout abandonment',
    'receivables',
    'payment intelligence',
  ],
  openGraph: {
    title: 'RECLAIM — Autonomous Revenue Recovery Infrastructure',
    description:
      'Find the revenue slipping away. Decide what to do. Recover it safely.',
    type: 'website',
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#050507',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-ink-950 font-sans">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
