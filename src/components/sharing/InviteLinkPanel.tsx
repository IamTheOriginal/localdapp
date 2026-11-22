import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { inviteLinkFromUri } from '@/services/inviteLinks.ts';

/**
 * One presentation for every outgoing invite: a scannable QR plus a clickable
 * https link with copy and system-share actions. The QR and the link both carry
 * the wrapped https form, so a phone camera scan opens the app directly.
 */
export default function InviteLinkPanel({ uri, shareTitle }: { uri: string; shareTitle: string }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLinkFromUri(uri);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  const share = async () => {
    try {
      await navigator.share({ title: shareTitle, url: link });
    } catch {
      // Dismissed the share sheet — nothing to do.
    }
  };

  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row">
      <div className="shrink-0 rounded-xl border border-border bg-white p-2" aria-hidden="true">
        <QRCodeSVG value={link} size={112} level="L" />
      </div>
      <div className="w-full min-w-0 flex-1 space-y-2">
        <Label htmlFor={`invite-link-${uri.slice(-8)}`}>Invite link</Label>
        <Input
          id={`invite-link-${uri.slice(-8)}`}
          readOnly
          value={link}
          className="font-mono text-xs"
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
            <Button variant="outline" size="sm" onClick={() => void share()}>
              <Share2 className="h-4 w-4" />
              Share…
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Anyone with this link can request access — send it privately.
        </p>
      </div>
    </div>
  );
}
