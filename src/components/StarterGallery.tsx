import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createStarterDapp, fetchStarterCatalog, fetchStarterDefinition } from '../services/store/index.ts';
import type { CodeAppStarterSummary } from '../services/store/starters.ts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface StarterGalleryProps {
  /** Called with the new dapp id after a starter is applied (e.g. to close a host modal). */
  onApplied?: (dappId: string) => void;
}

/**
 * Starter rows size to their container, not the viewport: below ~28rem the
 * row stacks (icon + text, then a full-width button), above it the button sits
 * at the end of the row. That keeps the gallery readable both inside the
 * narrow mobile dialog and in the wide desktop column of the New Dapp dialog.
 */
export default function StarterGallery({ onApplied }: StarterGalleryProps) {
  const navigate = useNavigate();
  const creatingStarterRef = useRef<string | null>(null);
  const [starters, setStarters] = useState<CodeAppStarterSummary[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [creatingStarterId, setCreatingStarterId] = useState<string | null>(null);
  const [starterError, setStarterError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStarterCatalog()
      .then((catalog) => { if (!cancelled) setStarters(catalog); })
      .catch((error: unknown) => { if (!cancelled) setCatalogError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, []);

  const handleCreateStarter = async (starter: CodeAppStarterSummary) => {
    if (creatingStarterRef.current) return;
    creatingStarterRef.current = starter.id;
    setCreatingStarterId(starter.id);
    setStarterError(null);
    try {
      const definition = await fetchStarterDefinition(starter);
      const id = await createStarterDapp(definition);
      // Navigate while this component is still mounted, then let the host react
      // (e.g. close the New Dapp modal).
      void navigate(`/dapp/${id}/app`);
      onApplied?.(id);
    } catch (error) {
      setStarterError(error instanceof Error ? error.message : String(error));
    } finally {
      creatingStarterRef.current = null;
      setCreatingStarterId(null);
    }
  };

  if (catalogError) {
    return (
      <section aria-label="Starter gallery">
        <Alert variant="destructive" role="alert">Could not load the starter gallery: {catalogError}</Alert>
      </section>
    );
  }

  if (starters === null) {
    return (
      <section aria-label="Starter gallery">
        <p className="px-1 py-2 text-sm text-muted-foreground" aria-live="polite">Loading starters…</p>
      </section>
    );
  }

  return (
    <section aria-label="Starter gallery" className="@container">
      {starterError ? <Alert variant="destructive" role="alert" className="mb-3">{starterError}</Alert> : null}
      <ul className="grid gap-3">
        {starters.map((starter) => (
          <li
            key={starter.id}
            data-starter-id={starter.id}
            className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-sm @md:flex-row @md:items-center"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl"
                style={{ backgroundColor: `${starter.color}20` }}
                aria-hidden="true"
              >
                {starter.icon}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold tracking-[-0.01em]">{starter.name}</h3>
                <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{starter.pitch}</p>
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="w-full @md:w-auto @md:shrink-0"
              disabled={creatingStarterId !== null}
              onClick={() => { void handleCreateStarter(starter); }}
              aria-label={`Create ${starter.name}`}
            >
              {creatingStarterId === starter.id ? 'Creating…' : `Create ${starter.name}`}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
