import { useState } from 'react';
import { FilePlus2, GitBranch, LayoutGrid } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import StarterGallery from './StarterGallery.tsx';
import GithubImportPanel from './GithubImportPanel.tsx';
import { MAX_CODE_APP_NAME_LENGTH } from '../services/codeAppManifest.ts';

const DAPP_COLORS = ['#f97316', '#6366f1', '#a78bfa', '#60a5fa', '#f472b6', '#fbbf24', '#10b981', '#f87171'];
const DAPP_ICONS = ['📱', '📋', '🎮', '📊', '🛒', '📝', '🎯', '💡', '📦', '🗂️', '⚡', '🔧'];

const swatchBase = 'flex h-9 w-9 cursor-pointer items-center justify-center border-2 [touch-action:manipulation] transition-[transform,border-color,box-shadow] outline-none focus-visible:ring-3 focus-visible:ring-ring/25';

type CreateMode = 'blank' | 'starters' | 'github';

interface Props {
  onClose: () => void;
  onCreate: (name: string, icon: string, color: string) => void;
}

/**
 * Unified creation dialog with a crisp 3-mode switcher (Blank, Starter gallery,
 * Add from GitHub) instead of expanding sideways with awkward secondary toggles.
 */
export default function CreateDappModal({ onClose, onCreate }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(DAPP_ICONS[0]);
  const [color, setColor] = useState(DAPP_COLORS[0]);
  const [mode, setMode] = useState<CreateMode>('blank');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode !== 'blank' || !name.trim()) return;
    onCreate(name.trim(), icon, color);
    onClose();
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn('sm:max-w-lg', mode === 'starters' && 'sm:max-w-2xl')}>
        {/* min-w-0 + grid-cols-1 on every nested grid: a grid item defaults to min-width:auto
            (= its min-content width), so the no-wrap name preview below would otherwise widen
            the whole form past the dialog and push the buttons out of view while typing. */}
        <form onSubmit={handleSubmit} className="grid min-w-0 grid-cols-1 gap-5">
          <DialogHeader>
            <DialogTitle>Create New Dapp</DialogTitle>
            <DialogDescription>Start blank, pick a ready-made app from the starter gallery, or copy a Code App from a public GitHub link.</DialogDescription>
          </DialogHeader>

          {/* Segmented mode switcher */}
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/60 p-1">
            <button
              type="button"
              onClick={() => setMode('blank')}
              aria-pressed={mode === 'blank'}
              className={cn(
                'flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-[background-color,color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                mode === 'blank' ? 'bg-card text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <FilePlus2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t('Blank')}</span>
            </button>
            <button
              type="button"
              aria-expanded={mode === 'starters'}
              aria-controls="starter-gallery-panel"
              onClick={() => setMode((current) => (current === 'starters' ? 'blank' : 'starters'))}
              className={cn(
                'flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-[background-color,color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                mode === 'starters' ? 'bg-card text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">Starter gallery</span>
            </button>
            <button
              type="button"
              aria-expanded={mode === 'github'}
              aria-controls="github-import-panel"
              onClick={() => setMode((current) => (current === 'github' ? 'blank' : 'github'))}
              className={cn(
                'flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-[background-color,color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                mode === 'github' ? 'bg-card text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">Add from GitHub</span>
            </button>
          </div>

          {mode === 'blank' && (
            <div className="grid min-w-0 grid-cols-1 gap-4">
              {/* Preview */}
              <div className="flex items-center gap-3.5 rounded-xl border border-border bg-muted/35 p-3.5">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border text-2xl"
                  style={{ backgroundColor: `${color}1a`, borderColor: `${color}30`, color }}
                  aria-hidden="true"
                >
                  {icon}
                </div>
                <div className="w-0 min-w-0 flex-1" data-testid="dapp-name-preview">
                  <p className="truncate text-sm font-semibold text-foreground">{name || 'Untitled Dapp'}</p>
                  <p className="text-xs text-muted-foreground">Preview</p>
                </div>
              </div>

              {/* Name */}
              <div className="grid min-w-0 grid-cols-1 gap-2">
                <Label htmlFor="dapp-name">Dapp name</Label>
                <Input
                  id="dapp-name"
                  name="dappName"
                  autoFocus
                  placeholder="My awesome app"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={MAX_CODE_APP_NAME_LENGTH}
                  autoComplete="off"
                />
              </div>

              {/* Icon */}
              <div className="grid min-w-0 grid-cols-1 gap-2">
                <Label id="dapp-icon-label">Icon</Label>
                <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="dapp-icon-label">
                  {DAPP_ICONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      aria-label={`Select icon ${ic}`}
                      aria-pressed={icon === ic}
                      className={cn(
                        swatchBase,
                        'rounded-lg text-lg',
                        icon === ic
                          ? 'border-primary bg-primary/10'
                          : 'border-transparent bg-muted hover:border-border',
                      )}
                      onClick={() => setIcon(ic)}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              </div>

              {/* Color */}
              <div className="grid min-w-0 grid-cols-1 gap-2">
                <Label id="dapp-color-label">Color</Label>
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby="dapp-color-label">
                  {DAPP_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Select color ${c}`}
                      aria-pressed={color === c}
                      className={cn(
                        swatchBase,
                        'h-7 w-7 rounded-full',
                        color === c
                          ? 'scale-110 border-foreground shadow-sm'
                          : 'border-transparent hover:scale-105',
                      )}
                      style={{ backgroundColor: c }}
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {mode === 'starters' && (
            <div
              id="starter-gallery-panel"
              className="max-h-[min(56vh,30rem)] overflow-y-auto overscroll-contain rounded-xl border border-border/80 bg-muted/25 p-3"
            >
              <StarterGallery onApplied={() => onClose()} />
            </div>
          )}

          {mode === 'github' && (
            <div
              id="github-import-panel"
              className="@container max-h-[min(56vh,30rem)] overflow-y-auto overscroll-contain rounded-xl border border-border/80 bg-muted/25 p-3.5"
            >
              <GithubImportPanel onCreated={() => onClose()} />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
            {mode === 'blank' && (
              <Button variant="default" type="submit" disabled={!name.trim()}>
                Create Dapp
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
