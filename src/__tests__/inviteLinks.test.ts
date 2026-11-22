import { describe, expect, it } from 'vitest';
import { inviteLinkFromUri, inviteUriFromText, isInviteUri, isPairingInviteUri, isSourceShareUri, sourceShareCodeFromLocation } from '../services/inviteLinks.ts';
import { createRelationshipInvite } from '../services/relationshipProtocol.ts';
import { appInviteUri } from '../services/store/invites.ts';

describe('invite links', () => {
  const dappUri = 'dapp://invite/app/dapp-lobby-abc123/s3cr3t+pass-word';
  const pairUri = 'dapp://invite/pair/AbCdEf0123456789_-AbCdEf0123456789_-AbCdEf0123456789xx';

  it('wraps and unwraps an app invite URI losslessly', () => {
    const link = inviteLinkFromUri(dappUri, 'https://example.app');
    expect(link.startsWith('https://example.app/invite#code=')).toBe(true);
    expect(inviteUriFromText(link)).toBe(dappUri);
  });

  it('wraps and unwraps a pairing URI losslessly', () => {
    const link = inviteLinkFromUri(pairUri, 'https://example.app');
    expect(inviteUriFromText(link)).toBe(pairUri);
  });

  it('round-trips the URIs the real producers emit', async () => {
    const { uri } = await createRelationshipInvite();
    expect(isInviteUri(uri)).toBe(true);
    expect(isPairingInviteUri(uri)).toBe(true);
    expect(inviteUriFromText(inviteLinkFromUri(uri, 'https://example.app'))).toBe(uri);

    const joinUri = appInviteUri('dapp-lobby-x', 'pw-123456');
    expect(isInviteUri(joinUri)).toBe(true);
    expect(isPairingInviteUri(joinUri)).toBe(false);
    expect(inviteUriFromText(inviteLinkFromUri(joinUri, 'https://example.app'))).toBe(joinUri);
  });

  it('carries the secret in the fragment — never in the path or the query, which reach servers and link previews', () => {
    const link = inviteLinkFromUri(dappUri, 'https://example.app');
    const url = new URL(link);
    expect(url.pathname).toBe('/invite');
    expect(url.search).toBe('');
    expect(new URLSearchParams(url.hash.slice(1)).get('code')).toBe(dappUri);
  });

  it('still opens links from older builds that carried the code in the query string', () => {
    expect(inviteUriFromText(`https://example.app/invite?code=${encodeURIComponent(dappUri)}`)).toBe(dappUri);
    expect(inviteUriFromText(`https://example.app/invite?code=${encodeURIComponent(pairUri)}`)).toBe(pairUri);
  });

  it('passes raw URIs through unchanged, with whitespace trimmed', () => {
    expect(inviteUriFromText(`  ${dappUri}\n`)).toBe(dappUri);
    expect(inviteUriFromText(pairUri)).toBe(pairUri);
  });

  it('accepts links from a different host than the current one', () => {
    const link = inviteLinkFromUri(pairUri, 'https://other-host.example');
    expect(inviteUriFromText(link)).toBe(pairUri);
  });

  it('normalizes the web+dapp protocol-handler scheme back to dapp://', () => {
    expect(inviteUriFromText(`web+${dappUri}`)).toBe(dappUri);
    expect(inviteUriFromText(`web+${pairUri}`)).toBe(pairUri);
    expect(inviteUriFromText(pairUri.replace('dapp://', 'WEB+DAPP://'))).toBe(pairUri);
    // A protocol-handler launch lands as /invite?code=<encoded web+dapp URI>.
    const handlerLink = `https://example.app/invite?code=${encodeURIComponent(dappUri.replace('dapp://', 'web+dapp://'))}`;
    expect(inviteUriFromText(handlerLink)).toBe(dappUri);
    // web+ alone grants nothing beyond the two known kinds.
    expect(inviteUriFromText('web+dapp://invite/other/x')).toBeNull();
    expect(inviteUriFromText('web+other://invite/pair/abc')).toBeNull();
  });

  it('rejects text that is neither an invite URI nor an invite link', () => {
    expect(inviteUriFromText('')).toBeNull();
    expect(inviteUriFromText('hello world')).toBeNull();
    expect(inviteUriFromText('https://example.app/invite')).toBeNull();
    expect(inviteUriFromText('https://example.app/invite?code=javascript:alert(1)')).toBeNull();
    expect(inviteUriFromText('http://[bad')).toBeNull();
    // Retired formats are dead, not grandfathered.
    expect(inviteUriFromText('dapp-builder://relationship-pair/v2?code=abc')).toBeNull();
    expect(inviteUriFromText('dapp://room-id/room-password')).toBeNull();
    expect(inviteUriFromText('dapp://invite/lobby-id/lobby-password')).toBeNull();
  });

  it('recognizes exactly the two invite kinds', () => {
    expect(isInviteUri(dappUri)).toBe(true);
    expect(isInviteUri(pairUri)).toBe(true);
    expect(isInviteUri('https://example.app')).toBe(false);
    expect(isInviteUri('dapp://invite/other/x')).toBe(false);
    expect(isPairingInviteUri(dappUri)).toBe(false);
  });

  it('keeps a source-share capability separate from an app invitation', () => {
    const sourceUri = `dapp://share/source/source-share-id/${'a'.repeat(64)}/2026-10-01T12%3A00%3A00.000Z`;
    expect(isSourceShareUri(sourceUri)).toBe(true);
    expect(isInviteUri(sourceUri)).toBe(false);
    expect(sourceShareCodeFromLocation({ hash: `#code=${encodeURIComponent(sourceUri)}`, search: '' })).toBe(sourceUri);
    expect(sourceShareCodeFromLocation({ hash: '', search: `?code=${encodeURIComponent(sourceUri)}` })).toBe(sourceUri);
    expect(sourceShareCodeFromLocation({ hash: `#code=${encodeURIComponent(dappUri)}`, search: '' })).toBeNull();
  });
});
