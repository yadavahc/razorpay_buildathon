import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DashboardShell } from '@/components/dashboard/shell';

export const metadata: Metadata = {
  title: 'Control tower',
  description: 'Revenue recovery control tower.',
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
