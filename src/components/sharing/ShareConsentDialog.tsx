import type { CodeAppBindingDeclaration, DappContactHandle } from '@/types.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';

interface ShareConsentDialogProps {
  open: boolean;
  appName: string;
  shareLabel: string;
  contacts: DappContactHandle[];
  events: CodeAppBindingDeclaration[];
  actions: CodeAppBindingDeclaration[];
  onResolve: (result: { confirmed: boolean }) => void;
}

function DeclarationList({ title, description, declarations }: {
  title: string;
  description: string;
  declarations: CodeAppBindingDeclaration[];
}) {
  return (
    <section className="space-y-2 rounded-xl border border-border p-3">
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ul className="space-y-2">
        {declarations.map((declaration) => (
          <li key={declaration.id} className="rounded-lg bg-muted/50 p-2.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-2">
              <span className="font-medium">{declaration.label}</span>
              <code className="break-all text-xs text-muted-foreground">{declaration.id}</code>
            </div>
            {(declaration.payload?.length ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                Fields: {declaration.payload?.map((field) => `${field.name}${field.required ? '' : '?'}`).join(', ')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ShareConsentDialog({ open, appName, shareLabel, contacts, events, actions, onResolve }: ShareConsentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onResolve({ confirmed: false }); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Allow “{appName}” to start {shareLabel}?</DialogTitle>
          <DialogDescription>
            This creates a separate encrypted channel for each selected contact. Review exactly what may cross those channels.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="font-semibold">Contacts</h3>
          <div className="flex flex-wrap gap-2">
            {contacts.map((contact) => (
              <Badge key={contact.handle} variant={contact.verified ? 'secondary' : 'outline'}>{contact.displayName}{contact.verified ? ' · Verified' : ' · Not verified'}</Badge>
            ))}
          </div>
          {contacts.some((contact) => !contact.verified) && (
            <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              You have not verified {contacts.filter((contact) => !contact.verified).map((contact) => contact.displayName).join(', ')} yet. Pairing only proves that someone had the invite — compare the safety number under Contacts before sharing anything you would not send to a stranger.
            </p>
          )}
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          <DeclarationList title="Information sent" description="Events this app may send to the selected contacts." declarations={events} />
          <DeclarationList title="Operations received" description="Actions those contacts may invoke in this app." declarations={actions} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onResolve({ confirmed: false })}>Cancel</Button>
          <Button onClick={() => onResolve({ confirmed: true })}>Allow sharing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
