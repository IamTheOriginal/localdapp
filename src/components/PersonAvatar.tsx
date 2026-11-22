import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The one avatar for a person, everywhere: members lists, contact pickers,
 * request inboxes, consent dialogs. Initial + deterministic color derived from
 * a stable seed (public key when available, display name otherwise), so the
 * same person renders identically on every surface.
 */

// Hue/tone pairs chosen to stay readable on both themes; the seed hash picks one.
const AVATAR_PALETTE = [
  { bg: 'hsl(16 85% 92%)', fg: 'hsl(16 70% 32%)' },
  { bg: 'hsl(150 60% 90%)', fg: 'hsl(150 55% 24%)' },
  { bg: 'hsl(210 80% 92%)', fg: 'hsl(210 70% 32%)' },
  { bg: 'hsl(265 70% 93%)', fg: 'hsl(265 55% 38%)' },
  { bg: 'hsl(330 70% 93%)', fg: 'hsl(330 60% 36%)' },
  { bg: 'hsl(45 85% 88%)', fg: 'hsl(40 70% 28%)' },
  { bg: 'hsl(185 60% 89%)', fg: 'hsl(190 65% 26%)' },
  { bg: 'hsl(0 70% 93%)', fg: 'hsl(0 60% 36%)' },
] as const;

function paletteFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

const AVATAR_SIZES = {
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-11 w-11 text-base',
} as const;

interface PersonAvatarProps {
  name: string;
  /** Stable identity seed (public key, relationship id); falls back to name. */
  seed?: string;
  size?: keyof typeof AVATAR_SIZES;
  verified?: boolean;
  className?: string;
}

export function PersonAvatar({ name, seed, size = 'md', verified = false, className }: PersonAvatarProps) {
  const palette = paletteFor(seed || name || '?');
  const initial = (name.trim().charAt(0) || '?').toUpperCase();
  return (
    <span className={cn('relative inline-flex shrink-0', className)} aria-hidden="true">
      <span
        className={cn('flex items-center justify-center rounded-full font-semibold', AVATAR_SIZES[size])}
        style={{ backgroundColor: palette.bg, color: palette.fg }}
      >
        {initial}
      </span>
      {verified && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background text-primary shadow-sm">
          <ShieldCheck className="h-3 w-3" />
        </span>
      )}
    </span>
  );
}
