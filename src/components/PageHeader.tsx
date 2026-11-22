import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The one page heading: icon chip, title, description and an action row that
 * wraps under the title on narrow screens. Used by every routed page and by
 * the settings panels so headings share one size, weight and spacing.
 */
export function PageHeader({ icon, iconStyle, title, titleId, description, actions, className }: {
  icon?: ReactNode;
  /** Per-dapp tint for the icon chip (dapp colour); defaults to the primary tint. */
  iconStyle?: CSSProperties;
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6 flex flex-col gap-3.5 md:flex-row md:items-center md:justify-between', className)}>
      <div className="flex min-w-0 items-center gap-3">
        {icon && (
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-muted/60 text-base text-foreground"
            style={iconStyle}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 id={titleId} className="text-xl font-semibold tracking-[-0.025em] text-foreground [overflow-wrap:anywhere] sm:text-2xl">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:shrink-0 md:justify-end">{actions}</div>}
    </div>
  );
}
