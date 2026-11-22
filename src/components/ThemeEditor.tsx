import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateDappTheme } from '@/services/store/index.ts';
import { useI18n } from '@/i18n';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const THEME_PRESETS: { name: string; primary: string; radius: string; description: string }[] = [
  { name: 'Orange', primary: '#f97316', radius: '0.5rem', description: 'Default orange accent' },
  { name: 'Blue', primary: '#3b82f6', radius: '0.5rem', description: 'Clean blue' },
  { name: 'Emerald', primary: '#10b981', radius: '0.5rem', description: 'Fresh green' },
  { name: 'Rose', primary: '#f43f5e', radius: '0.5rem', description: 'Warm rose' },
  { name: 'Amber', primary: '#f59e0b', radius: '0.5rem', description: 'Golden amber' },
  { name: 'Violet', primary: '#8b5cf6', radius: '0.5rem', description: 'Deep violet' },
  { name: 'Cyan', primary: '#06b6d4', radius: '0.5rem', description: 'Bright cyan' },
  { name: 'Pink', primary: '#ec4899', radius: '0.5rem', description: 'Playful pink' },
  { name: 'Rounded', primary: '#f97316', radius: '1rem', description: 'Extra roundness' },
  { name: 'Sharp', primary: '#f97316', radius: '0rem', description: 'No rounding' },
];

// Per-dapp appearance: writes go through updateDappTheme into the shared dapp
// document; AppShell applies them as CSS variables around every Code App surface.
export default function ThemeEditor({ dappId, config }: { dappId: string; config: { theme?: { primary?: string; radius?: string } } }) {
  const { t } = useI18n();
  const primaryColor = config.theme?.primary || '#f97316';
  const borderRadius = config.theme?.radius || '0.5rem';

  // The theme lives in the shared dapp doc and every device applies it as a CSS
  // variable. So: the text field edits a LOCAL draft and only a complete, valid
  // colour is committed (typing "#f9" used to break the primary colour on every
  // connected device, and the field could not be cleared); the picker and the
  // slider fire per pointer tick and are throttled to one shared write per 150 ms.
  const [hexDraft, setHexDraft] = useState(primaryColor);
  const [radiusDraft, setRadiusDraft] = useState<string | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout> | null; patch: { primary?: string; radius?: string } }>({ timer: null, patch: {} });

  // Follow remote changes (and our own commits): when the value in the doc moves,
  // the drafts are re-seeded from it (adjusting state during render, no effect needed).
  const [seenTheme, setSeenTheme] = useState({ primaryColor, borderRadius });
  if (seenTheme.primaryColor !== primaryColor || seenTheme.borderRadius !== borderRadius) {
    setSeenTheme({ primaryColor, borderRadius });
    if (seenTheme.primaryColor !== primaryColor) setHexDraft(primaryColor);
    if (seenTheme.borderRadius !== borderRadius) setRadiusDraft(null);
  }
  useEffect(() => () => {
    const { timer, patch } = pending.current;
    if (timer) clearTimeout(timer);
    if (Object.keys(patch).length > 0) updateDappTheme(dappId, patch);
  }, [dappId]);

  const commitSoon = (patch: { primary?: string; radius?: string }) => {
    pending.current.patch = { ...pending.current.patch, ...patch };
    if (pending.current.timer) return;
    pending.current.timer = setTimeout(() => {
      const queued = pending.current.patch;
      pending.current = { timer: null, patch: {} };
      updateDappTheme(dappId, queued);
    }, 150);
  };

  const handleColorChange = (color: string) => {
    setHexDraft(color);
    commitSoon({ primary: color });
  };

  const hexIsValid = HEX_COLOR.test(hexDraft.trim());
  const commitHexDraft = () => {
    const value = hexDraft.trim().toLowerCase();
    if (HEX_COLOR.test(value)) {
      if (value !== primaryColor) updateDappTheme(dappId, { primary: value });
    } else {
      setHexDraft(primaryColor); // not a colour — back to what is in effect
    }
  };

  const handleRadiusChange = (radius: string) => {
    setRadiusDraft(radius);
    commitSoon({ radius });
  };
  const shownRadius = radiusDraft ?? borderRadius;

  const applyPreset = (preset: typeof THEME_PRESETS[0]) => {
    updateDappTheme(dappId, { primary: preset.primary, radius: preset.radius });
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Live Preview Card */}
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-border/80 bg-card p-6 text-center">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center text-2xl text-white font-bold transition-all duration-300"
          style={{ background: primaryColor, borderRadius: borderRadius === '0rem' ? '0' : undefined }}
        >
          A
        </div>
        <div className="text-sm text-muted-foreground">
          {t('Preview — your theme colors in action')}
        </div>
        <div className="flex flex-wrap gap-2 justify-center">
          <div className="px-4 py-1.5 rounded-md text-sm text-white font-medium transition-all"
            style={{ background: primaryColor, borderRadius }}>
            {t('Button')}
          </div>
          <div className="px-4 py-1.5 rounded-md text-sm border transition-all"
            style={{ borderColor: primaryColor, color: primaryColor, borderRadius }}>
            {t('Outline')}
          </div>
          <Badge style={{ background: primaryColor }}>{t('Badge')}</Badge>
        </div>
      </div>

      {/* Primary Color */}
      <div className="flex flex-col gap-3">
        <Label className="text-sm font-medium">{t('Primary Color')}</Label>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={primaryColor}
            onChange={(e) => handleColorChange(e.target.value)}
            aria-label={t('Pick the primary color')}
            className="h-10 w-10 cursor-pointer rounded-xl border border-input bg-card p-1"
          />
          <Input
            value={hexDraft}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={commitHexDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitHexDraft(); } }}
            aria-label={t('Primary color as hex value')}
            aria-invalid={!hexIsValid}
            maxLength={7}
            spellCheck={false}
            className="font-mono text-sm max-w-[120px]"
          />
        </div>
      </div>

      {/* Border Radius */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">{t('Corner Radius')}</Label>
          <span className="text-sm font-mono text-muted-foreground">{shownRadius}</span>
        </div>
        <input
          type="range"
          min="0"
          max="24"
          step="1"
          value={parseFloat(shownRadius) * 16}
          onChange={(e) => handleRadiusChange(`${Number(e.target.value) / 16}rem`)}
          className="w-full cursor-pointer accent-primary"
          aria-label={t('Border radius')}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{t('Sharp (0px)')}</span>
          <span>{t('Round (24px)')}</span>
        </div>
      </div>

      {/* Preset Themes */}
      <div className="flex flex-col gap-3">
        <Label className="text-sm font-medium">{t('Presets')}</Label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {THEME_PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              aria-pressed={primaryColor === preset.primary && borderRadius === preset.radius}
              onClick={() => applyPreset(preset)}
              className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-[border-color,background-color] outline-none focus-visible:ring-3 focus-visible:ring-ring/30 ${
                primaryColor === preset.primary && borderRadius === preset.radius
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-foreground/30'
              }`}
            >
              <div
                className="w-6 h-6 rounded-full shrink-0"
                style={{ background: preset.primary, borderRadius: preset.radius === '0rem' ? '0' : undefined }}
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium">{t(preset.name)}</span>
                <span className="text-xs text-muted-foreground">{t(preset.description)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
