import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A native <select> dressed like the Input / outline Button pair so it can sit
 * in a toolbar next to them. Uses the same soft focus ring as every other
 * control (ring-3 at 25%) instead of a hard 2px ring — a hard ring on a dark
 * control reads as a second "button" painted over a coloured one.
 *
 * The wrapper never exceeds its container: a select with long option labels
 * shrinks to fit instead of pushing a dialog wider than the viewport.
 */
function NativeSelect({
  className,
  wrapperClassName,
  compact = false,
  ...props
}: React.ComponentProps<"select"> & {
  wrapperClassName?: string
  /** Toolbar-density variant (h-8, text-xs) for inline rows such as member roles. */
  compact?: boolean
}) {
  return (
    <span data-slot="native-select" className={cn("relative inline-flex max-w-full min-w-0", wrapperClassName)}>
      <select
        className={cn(
          "w-full min-w-0 appearance-none rounded-xl border border-input bg-card pl-3 pr-9 text-sm font-medium text-foreground shadow-sm transition-[border-color,box-shadow,background-color] outline-none hover:border-primary/20 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
          compact ? "h-8 rounded-lg pl-2.5 pr-8 text-xs" : "h-10",
          className
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", compact ? "right-2.5 size-3.5" : "right-3 size-4")}
      />
    </span>
  )
}

export { NativeSelect }
