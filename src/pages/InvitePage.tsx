import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Boxes, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { inviteCodeFromLocation, isPairingInviteUri } from '@/services/inviteLinks.ts';
import { joinDapp } from '@/services/store/index.ts';

/**
 * Landing page for clickable invite links (https://…/invite#code=…): the
 * production-grade replacement for pasting raw dapp://invite/… URIs into a
 * textarea. Joining still requires an explicit tap — a link alone never
 * silently joins anything.
 */
export default function InvitePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Kept in state: the address is cleaned right after (below), the invite must survive that.
  const arriving = inviteCodeFromLocation(location);
  const [uri, setUri] = useState(arriving);
  if (arriving && arriving !== uri) setUri(arriving); // another invite opened while this page was showing

  // The code is a secret. Take it out of the address bar and the history entry, so it is not
  // synced by the browser, shown in screenshots, or sent along when an older `?code=` link reloads.
  useEffect(() => {
    if (window.location.hash || window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname);
  }, [location]);

  const kind = !uri ? 'invalid' : isPairingInviteUri(uri) ? 'pairing' : 'dapp';

  const joinApp = () => {
    if (!uri) return;
    setBusy(true);
    setError('');
    try {
      const id = joinDapp(uri);
      void navigate(`/dapp/${id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This invite link is not valid.');
      setBusy(false);
    }
  };

  const requestPairing = async () => {
    if (!uri) return;
    setBusy(true);
    setError('');
    try {
      const { joinRelationshipPairing } = await import('@/services/browserRelationshipRuntime.ts');
      await joinRelationshipPairing(uri);
      void navigate('/people');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not request pairing.');
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-lg items-center px-4 py-8">
      <Card className="w-full">
        {kind === 'invalid' && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />Invalid invite link</CardTitle>
              <CardDescription>This link does not contain a recognizable invite. Ask the sender for a fresh one.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" render={<Link to="/" />}>Back to home</Button>
            </CardContent>
          </>
        )}

        {kind === 'dapp' && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Boxes className="h-5 w-5 text-primary" aria-hidden="true" />You&apos;re invited to an app</CardTitle>
              <CardDescription>
                Joining connects this device to the app&apos;s invite lobby. The owner verifies your device before you become a member and see any data.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={joinApp}>{busy ? 'Joining…' : 'Join app'}</Button>
                <Button variant="outline" render={<Link to="/" />}>Not now</Button>
              </div>
            </CardContent>
          </>
        )}

        {kind === 'pairing' && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><UserRound className="h-5 w-5 text-primary" aria-hidden="true" />Someone wants to pair with you</CardTitle>
              <CardDescription>
                Pairing creates a private, encrypted connection between your devices. Names are exchanged automatically, and nothing is shared until both sides approve.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void requestPairing()}>{busy ? 'Requesting…' : 'Request pairing'}</Button>
                <Button variant="outline" render={<Link to="/" />}>Not now</Button>
              </div>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
