/**
 * One invite format for everything.
 *
 * Every invite is a `dapp://invite/…` URI with exactly two kinds:
 *   - `dapp://invite/pair/<code>`             — contact pairing (relationshipProtocol.ts)
 *   - `dapp://invite/app/<lobbyId>/<password>` — app join via lobby (store/invites.ts)
 *
 * Raw URIs stay the canonical, self-contained secrets; `inviteLinkFromUri`
 * wraps one into a clickable `https://<host>/invite#code=…` link that opens
 * this app's InvitePage, and `inviteUriFromText` normalizes whatever a user
 * pastes or scans (raw URI, wrapped link, or either with whitespace) back to
 * the raw URI.
 *
 * The code travels in the URL FRAGMENT: a fragment is never sent to a server, so
 * the secret (the lobby password / pairing seed is the only gate of that room)
 * stays out of the hosting server's and proxies' logs and out of the requests
 * messengers make to build link previews. Links from older builds carried it in
 * the query string (`?code=`); those still open. Never a path segment — hosting
 * setups that normalize `%2F` in paths would corrupt the room password.
 */

const INVITE_LINK_PATH = '/invite';

export const PAIR_INVITE_URI_PREFIX = 'dapp://invite/pair/';
export const APP_INVITE_URI_PREFIX = 'dapp://invite/app/';
export const SOURCE_SHARE_URI_PREFIX = 'dapp://share/source/';

/**
 * OS-level protocol-handler launches deliver `web+dapp://invite/…` — custom
 * schemes must be `web+`-prefixed for handler registration (manifest
 * `protocol_handlers`), while the canonical self-contained secret stays
 * `dapp://invite/…`. Folds the handler scheme back onto the canonical one.
 */
function normalizeInviteScheme(value: string): string {
  return /^web\+dapp:\/\//i.test(value) ? `dapp://${value.slice('web+dapp://'.length)}` : value;
}

export function isInviteUri(value: string): boolean {
  return value.startsWith(PAIR_INVITE_URI_PREFIX) || value.startsWith(APP_INVITE_URI_PREFIX);
}

/** A source-share capability names only a temporary transfer room, never a dapp room. */
export function isSourceShareUri(value: string): boolean {
  return value.startsWith(SOURCE_SHARE_URI_PREFIX);
}

/** True for contact pairing invites (as opposed to app join invites). */
export function isPairingInviteUri(value: string): boolean {
  return value.startsWith(PAIR_INVITE_URI_PREFIX);
}

/** Wraps a raw invite URI into a clickable https link for this app instance. */
export function inviteLinkFromUri(uri: string, origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}${INVITE_LINK_PATH}#code=${encodeURIComponent(uri.trim())}`;
}

/** The invite URI a link location carries: in the fragment (current links), else in the query (older links, the OS protocol handler). */
export function inviteCodeFromLocation(location: { hash: string; search: string }): string | null {
  for (const part of [location.hash.replace(/^#/, ''), location.search.replace(/^\?/, '')]) {
    const code = normalizeInviteScheme(new URLSearchParams(part).get('code')?.trim() ?? '');
    if (isInviteUri(code)) return code;
  }
  return null;
}

/** Reads a source-share capability from a URL fragment (or legacy query). */
export function sourceShareCodeFromLocation(location: { hash: string; search: string }): string | null {
  for (const part of [location.hash.replace(/^#/, ''), location.search.replace(/^\?/, '')]) {
    const code = normalizeInviteScheme(new URLSearchParams(part).get('code')?.trim() ?? '');
    if (isSourceShareUri(code)) return code;
  }
  return null;
}

/**
 * Extracts the raw invite URI from pasted or scanned text.
 * Accepts a raw `dapp://invite/…` URI, its `web+dapp://` protocol-handler
 * form, an https invite link from any host (with either scheme in `code`),
 * or any of those with surrounding whitespace. Returns null otherwise.
 */
export function inviteUriFromText(text: string): string | null {
  const trimmed = normalizeInviteScheme(text.trim());
  if (!trimmed) return null;
  if (isInviteUri(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const code = inviteCodeFromLocation(new URL(trimmed));
      if (code) return code;
    } catch {
      return null;
    }
  }
  return null;
}
