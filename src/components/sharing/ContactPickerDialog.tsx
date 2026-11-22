import { useEffect, useState } from 'react';
import type { DappContactHandle } from '@/types.ts';
import { listDappContacts } from '@/services/store/contacts.ts';
import { getRootDoc } from '@/services/store/docs.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { PersonAvatar } from '@/components/PersonAvatar.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';

interface ContactPickerDialogProps {
  open: boolean;
  dappId: string;
  label?: string;
  min: number;
  max: number;
  onResolve: (contacts: DappContactHandle[]) => void;
}

export default function ContactPickerDialog({ open, dappId, label, min, max, onResolve }: ContactPickerDialogProps) {
  const [contacts, setContacts] = useState<DappContactHandle[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      setLoading(true);
      try {
        const next = await listDappContacts(dappId);
        if (active) setContacts(next);
      } finally {
        if (active) setLoading(false);
      }
    };
    // Intentional sync reset: a reopened picker must never flash the previous
    // selection, so this cannot wait for the async contact refresh.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(new Set());
    void refresh();
    const rootDoc = getRootDoc();
    const relationships = rootDoc.getMap('relationships');
    const people = rootDoc.getMap('people');
    const handleChange = () => void refresh();
    relationships.observeDeep(handleChange);
    people.observeDeep(handleChange);
    return () => {
      active = false;
      relationships.unobserveDeep(handleChange);
      people.unobserveDeep(handleChange);
    };
  }, [dappId, open]);

  const toggle = (handle: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked && next.size < max) next.add(handle);
      if (!checked) next.delete(handle);
      return next;
    });
  };

  const chosen = contacts.filter((contact) => selected.has(contact.handle));

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onResolve([]); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{label || 'Choose contacts'}</DialogTitle>
          <DialogDescription>
            Select {min === max ? `${min}` : `${min}–${max}`} contact{max === 1 ? '' : 's'}. The app receives only the contacts you choose.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          {loading && contacts.length === 0 && <p role="status" className="py-6 text-center text-sm text-muted-foreground">Loading contacts…</p>}
          {!loading && contacts.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No active paired contacts yet.</p>}
          {contacts.map((contact) => {
            const checked = selected.has(contact.handle);
            const disabled = !checked && selected.size >= max;
            return (
              <label key={contact.handle} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-border p-3 hover:bg-muted/50 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30">
                <Checkbox
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(value) => toggle(contact.handle, value === true)}
                  aria-label={`Select ${contact.displayName}`}
                />
                <PersonAvatar name={contact.displayName} seed={contact.handle} verified={contact.verified} />
                <span className="min-w-0 flex-1 truncate font-medium">{contact.displayName}</span>
                <Badge variant={contact.verified ? 'secondary' : 'outline'}>{contact.verified ? 'Verified' : 'Unverified'}</Badge>
              </label>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onResolve([])}>Cancel</Button>
          <Button disabled={chosen.length < min || chosen.length > max} onClick={() => onResolve(chosen)}>
            Choose {chosen.length > 0 ? chosen.length : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
