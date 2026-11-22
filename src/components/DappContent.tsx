import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Content container for routed pages; AppShell owns navigation and the
 * scrolling viewport, so this only centres and pads. `wide` is the default
 * for card grids (Home, People); `narrow` for single-column management pages.
 */
export function DappContent({ children, width = 'wide', className }: {
  children: ReactNode;
  width?: 'wide' | 'narrow';
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full px-4 py-5 sm:px-7 sm:py-6', width === 'wide' ? 'max-w-[1320px] xl:px-9 xl:py-8' : 'max-w-3xl', className)}>
      {children}
    </div>
  );
}
