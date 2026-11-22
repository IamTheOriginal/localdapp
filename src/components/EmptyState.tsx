import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The one "nothing here yet" panel: icon chip, title, hint and optional actions. */
export function EmptyState({ icon, title, description, action, className }: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex w-full flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center', className)}>
      {icon && (
        <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/60 text-xl text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
      )}
      <h2 className="text-base font-semibold tracking-[-0.015em] text-foreground">{title}</h2>
      {description && <p className="max-w-md text-sm leading-6 text-muted-foreground">{description}</p>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
