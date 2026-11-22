import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Labels wrap instead of overflowing: sizes set a minimum height (44px on
// touch pointers, per the platform tap-target guidance) and vertical padding,
// so a long label grows the button rather than spilling out of a narrow
// column. Callers that must stay single-line add `whitespace-nowrap`.
const buttonVariants = cva(
  "group/button inline-flex max-w-full cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-center text-sm leading-tight font-medium [overflow-wrap:anywhere] transition-[background-color,color,border-color,box-shadow,transform] duration-150 outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        outline:
          "border-border bg-card text-foreground shadow-2xs hover:bg-muted/70 aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-card/80 dark:hover:bg-muted/80",
        secondary:
          "border-border/60 bg-secondary text-secondary-foreground hover:bg-muted aria-expanded:bg-secondary aria-expanded:text-secondary-foreground dark:hover:bg-accent",
        ghost:
          "text-muted-foreground hover:bg-muted/80 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:hover:bg-destructive/25 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "min-h-9 gap-2 px-3.5 py-2 pointer-coarse:min-h-11 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "min-h-6 gap-1 rounded-md px-2 py-0.5 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-8 gap-1.5 rounded-lg px-3 py-1 text-[0.8125rem] pointer-coarse:min-h-10 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "min-h-10 gap-2 px-4.5 py-2.5 pointer-coarse:min-h-11 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-9 shrink-0 pointer-coarse:size-10",
        "icon-xs":
          "size-6 shrink-0 rounded-md in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 shrink-0 rounded-md in-data-[slot=button-group]:rounded-md",
        "icon-lg": "size-9 shrink-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button }
