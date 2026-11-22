import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * The one boxed notice: inline errors, hints, warnings and success notes all
 * use it so tone comes from the token palette (readable in both themes)
 * rather than per-call-site colour classes. Pass `role="alert"` / `"status"`
 * where the message must be announced.
 */
const alertVariants = cva(
  "flex w-full min-w-0 gap-3 rounded-xl border px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere] [&>svg]:mt-1 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        muted: "border-border/70 bg-muted/60 text-muted-foreground",
        info: "border-primary/30 bg-primary/5 text-foreground",
        success: "border-success/30 bg-success/10 text-foreground",
        warning: "border-warning/40 bg-warning/10 text-foreground",
        destructive: "border-destructive/30 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {
      variant: "muted",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Alert, alertVariants }
