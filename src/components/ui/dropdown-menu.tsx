import type { ComponentProps } from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { ChevronRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

const popupClassName =
  "z-50 max-h-(--available-height) min-w-44 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl border border-border/80 bg-popover p-1 text-sm text-popover-foreground shadow-[0_12px_40px_rgba(15,16,24,0.16)] outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"

function DropdownMenuContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "end",
  alignOffset = 0,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50 outline-none"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(popupClassName, className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

const itemClassName =
  "relative flex min-h-8 cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none select-none pointer-coarse:min-h-10 data-highlighted:bg-muted data-highlighted:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 data-[variant=destructive]:text-destructive"

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(itemClassName, className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(itemClassName, "data-popup-open:bg-muted", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" aria-hidden="true" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  sideOffset = 2,
  ...props
}: ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      side="right"
      align="start"
      sideOffset={sideOffset}
      className={className}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
}
