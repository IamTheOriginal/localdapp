import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CodeAppBindingDeclaration, DappListItem } from '@/types';
import { useDappsList } from '@/hooks/useYjs';
import { parseCodeAppManifest } from '@/services/codeAppManifest';
import { isFieldTypeCompatible, suggestFieldMap, validateFieldMap } from '@/services/bindingPayload';
import { getCodeAppFile } from '@/services/store/source';
import { getDappSourceDoc, getDappSourcePersistence, getRootDoc } from '@/services/store/docs';
import {
  deleteDirectBinding,
  listDirectBindings,
  listDirectDeliveries,
  pauseDirectBinding,
  resumeDirectBinding,
  type DirectBinding,
} from '@/services/store/directBindings';
import { approveDirectCodeBinding } from '@/services/directCodeBindingRuntime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

interface Endpoint {
  key: string;
  dapp: DappListItem;
  declaration: CodeAppBindingDeclaration;
}

export default function DirectBindingsSettings() {
  const dapps = useDappsList();
  const [revision, setRevision] = useState(0);
  const [sourceKey, setSourceKey] = useState('');
  const [destinationKey, setDestinationKey] = useState('');
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({});
  const [suggestedFor, setSuggestedFor] = useState('');
  const [showSourceFields, setShowSourceFields] = useState(false);
  const [showDestinationFields, setShowDestinationFields] = useState(false);
  const [showFieldMapping, setShowFieldMapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const dappIdsKey = dapps.map(({ id }) => id).join('|'); // IDs are the subscription identity.

  useEffect(() => {
    const root = getRootDoc();
    const refresh = () => setRevision((value) => value + 1);
    root.on('update', refresh);
    const ids = dappIdsKey ? dappIdsKey.split('|') : [];
    const maps = ids.map((id) => getDappSourceDoc(id).getMap('files'));
    maps.forEach((map) => map.observeDeep(refresh));
    for (const id of ids) void getDappSourcePersistence(id)?.whenSynced.then(refresh);
    return () => {
      root.off('update', refresh);
      maps.forEach((map) => map.unobserveDeep(refresh));
    };
  }, [dappIdsKey]);

  const { events, actions } = useMemo(() => {
    const events: Endpoint[] = [];
    const actions: Endpoint[] = [];
    for (const dapp of dapps) {
      const parsed = parseCodeAppManifest(getCodeAppFile(dapp.id, 'manifest.yaml'));
      if (parsed.error) continue;
      for (const declaration of parsed.manifest.bindings?.events ?? []) events.push({ key: `${dapp.id}:${declaration.id}`, dapp, declaration });
      if (dapp.role !== 'viewer') {
        for (const declaration of parsed.manifest.bindings?.actions ?? []) actions.push({ key: `${dapp.id}:${declaration.id}`, dapp, declaration });
      }
    }
    return { events, actions };
    // revision is the Yjs invalidation counter: the memo reads manifest state
    // that lives outside React, so the "unnecessary" dependency is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dapps, revision]);

  const bindings = listDirectBindings();
  const deliveries = listDirectDeliveries();

  const source = events.find(({ key }) => key === sourceKey);
  const destination = actions.find(({ key }) => key === destinationKey);
  const destinationFields = destination?.declaration.payload ?? [];

  // Re-suggest the field map whenever the source/destination selection changes, without an
  // effect: adjusting state during render (guarded by a tracked selection key) avoids the extra
  // commit a useEffect-driven setState would cause.
  const selectionKey = `${sourceKey}::${destinationKey}`;
  if (selectionKey !== suggestedFor) {
    setSuggestedFor(selectionKey);
    setFieldMap(suggestFieldMap(source?.declaration.payload, destination?.declaration.payload));
  }

  const fieldMapValidation = validateFieldMap(source?.declaration.payload, destination?.declaration.payload, fieldMap);

  const approve = async () => {
    if (!source || !destination || approving || !fieldMapValidation.ok) return;
    setApproving(true);
    try {
      await approveDirectCodeBinding({
        sourceDappId: source.dapp.id,
        sourceEventId: source.declaration.id,
        destinationDappId: destination.dapp.id,
        destinationActionId: destination.declaration.id,
        fieldMap,
      });
      setError(null);
      setSourceKey('');
      setDestinationKey('');
      setFieldMap({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApproving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle><span aria-hidden="true">🔗</span> Direct Code App bindings</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Explicitly approve a declared event from one local Code App to invoke a declared action in another. Payloads are delivered when the destination app is open.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="binding-source">Source event</Label>
            <NativeSelect id="binding-source" value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} wrapperClassName="w-full">
              <option value="">Choose an event…</option>
              {events.map((endpoint) => <option key={endpoint.key} value={endpoint.key}>{endpoint.dapp.name} — {endpoint.declaration.label}</option>)}
            </NativeSelect>
            {source && (
              <AttributeDisclosure
                id="binding-source-fields"
                label={`Attributes (${source.declaration.payload?.length ?? 0})`}
                open={showSourceFields}
                onToggle={() => setShowSourceFields((value) => !value)}
              >
                {source.declaration.payload?.length
                  ? (
                    <ul className="space-y-0.5">
                      {source.declaration.payload.map((field) => (
                        <li key={field.name}>{field.label || field.name} ({field.type})</li>
                      ))}
                    </ul>
                  )
                  : <p>none declared — opaque payload</p>}
              </AttributeDisclosure>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="binding-destination">Destination action</Label>
            <NativeSelect id="binding-destination" value={destinationKey} onChange={(event) => setDestinationKey(event.target.value)} wrapperClassName="w-full">
              <option value="">Choose an action…</option>
              {actions.map((endpoint) => <option key={endpoint.key} value={endpoint.key}>{endpoint.dapp.name} — {endpoint.declaration.label}</option>)}
            </NativeSelect>
            {destination && (
              <AttributeDisclosure
                id="binding-destination-fields"
                label={`Attributes (${destination.declaration.payload?.length ?? 0})`}
                open={showDestinationFields}
                onToggle={() => setShowDestinationFields((value) => !value)}
              >
                {destination.declaration.payload?.length
                  ? (
                    <ul className="space-y-0.5">
                      {destination.declaration.payload.map((field) => (
                        <li key={field.name}>{field.label || field.name} ({field.type}{field.required ? ', required' : ''})</li>
                      ))}
                    </ul>
                  )
                  : <p>none declared — opaque payload</p>}
              </AttributeDisclosure>
            )}
          </div>
          <Button onClick={() => { void approve(); }} disabled={!sourceKey || !destinationKey || approving || !fieldMapValidation.ok}>
            {approving ? 'Approving…' : 'Approve binding'}
          </Button>
        </div>
        {source && destination && destinationFields.length > 0 && (
          <div className="space-y-2 rounded-lg border p-3">
            <button
              type="button"
              className="inline-flex min-h-9 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
              aria-expanded={showFieldMapping}
              aria-controls="binding-field-mapping"
              onClick={() => setShowFieldMapping((value) => !value)}
            >
              {showFieldMapping ? '▾' : '▸'} Field mapping ({Object.keys(fieldMap).length}/{destinationFields.length} mapped)
            </button>
            {showFieldMapping && (
              <div id="binding-field-mapping" className="space-y-2">
                {destinationFields.map((field) => {
                  const compatibleSources = (source.declaration.payload ?? []).filter((sourceField) => isFieldTypeCompatible(sourceField.type, field.type));
                  return (
                    <div key={field.name} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-44 shrink-0 truncate max-sm:w-full">
                        {field.label || field.name}{field.required ? ' *' : ''}
                        <span className="text-muted-foreground"> ({field.type})</span>
                      </span>
                      <NativeSelect
                        compact
                        wrapperClassName="min-w-0 flex-1"
                        aria-label={`Source field for ${field.label || field.name}`}
                        value={fieldMap[field.name] ?? ''}
                        onChange={(event) => {
                          const value = event.target.value;
                          setFieldMap((current) => {
                            if (!value) {
                              const next = { ...current };
                              delete next[field.name];
                              return next;
                            }
                            return { ...current, [field.name]: value };
                          });
                        }}
                      >
                        <option value="">— unmapped —</option>
                        {compatibleSources.map((sourceField) => (
                          <option key={sourceField.name} value={sourceField.name}>{sourceField.label || sourceField.name} ({sourceField.type})</option>
                        ))}
                      </NativeSelect>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {!fieldMapValidation.ok && <p className="text-sm text-destructive">{fieldMapValidation.error}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {events.length === 0 || actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add <code>bindings.events</code> and <code>bindings.actions</code> declarations to local Code App manifests to create approvals.</p>
        ) : null}
        <div className="space-y-3">
          {bindings.length === 0 ? <p className="text-sm text-muted-foreground">No direct bindings approved on this device.</p> : bindings.map((binding) => (
            <BindingRow key={binding.id} binding={binding} dapps={dapps} pending={deliveries.filter((delivery) => delivery.bindingId === binding.id && delivery.status !== 'delivered').length} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AttributeDisclosure({ id, label, open, onToggle, children }: {
  id: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <div id={id} className="mt-1 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

function BindingRow({ binding, dapps, pending }: { binding: DirectBinding; dapps: DappListItem[]; pending: number }) {
  const name = (id: string) => dapps.find((dapp) => dapp.id === id)?.name ?? 'Deleted Dapp';
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium">{name(binding.sourceDappId)} · {binding.sourceEvent.label} → {name(binding.destinationDappId)} · {binding.destinationAction.label}</div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <Badge variant={binding.status === 'active' ? 'default' : 'secondary'}>{binding.status}</Badge>
          <span>{pending} pending</span>
          {binding.statusReason && <span>{binding.statusReason}</span>}
        </div>
      </div>
      <div className="flex gap-2">
        {binding.status === 'active'
          ? <Button size="sm" variant="secondary" onClick={() => pauseDirectBinding(binding.id)}>Pause</Button>
          : binding.status === 'paused' ? <Button size="sm" variant="secondary" onClick={() => resumeDirectBinding(binding.id)}>Resume</Button> : null}
        <Button size="sm" variant="destructive" onClick={() => deleteDirectBinding(binding.id)}>Delete</Button>
      </div>
    </div>
  );
}
