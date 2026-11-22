// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DappAccessRequestEntry } from '../hooks/useRequestsInbox.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Mocks {
  role: 'owner' | 'editor' | 'viewer' | null;
  shares: unknown[];
  accessRequests: unknown[];
  pairingRequests: unknown[];
  pendingInvites: unknown[];
}

const mocks = vi.hoisted((): Mocks => ({ role: 'owner', shares: [], accessRequests: [], pairingRequests: [], pendingInvites: [] }));

vi.mock('../hooks/useYjs.ts', () => ({
  useDappConfig: () => ({ meta: { name: 'Shopping', icon: '🛒', color: '#ff0000', createdAt: '', createdBy: 'founder' }, schema: { entities: [] } }),
  useCodeAppManifest: () => ({ manifest: { routes: [], channels: { shares: mocks.shares } }, error: null, localReady: true }),
  useMyRole: () => mocks.role,
  useDappsList: () => [{ id: 'd1', name: 'Shopping', icon: '🛒', color: '#ff0000' }],
}));
vi.mock('../hooks/useSharing.ts', () => ({
  useChannelSharingCatalog: () => ({ pendingInvites: mocks.pendingInvites, shares: [] }),
}));
vi.mock('../hooks/useRequestsInbox.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useRequestsInbox.ts')>();
  return {
    approvableAccessRequests: actual.approvableAccessRequests,
    countAccessRequestsByDapp: actual.countAccessRequestsByDapp,
    usePairingRequests: () => mocks.pairingRequests,
    useDappAccessRequests: () => mocks.accessRequests,
  };
});
vi.mock('../services/browserRelationshipRuntime.ts', () => ({ approveRelationshipPairing: vi.fn() }));
vi.mock('../components/sharing/DappInvitesPanel.tsx', () => ({ default: () => <div>invites panel</div> }));
vi.mock('../components/sharing/DappMembersList.tsx', () => ({ default: () => <div>members list</div> }));
vi.mock('../components/sharing/ActiveShares.tsx', () => ({ default: ({ dappId }: { dappId?: string }) => <div>active shares of {dappId}</div> }));
vi.mock('../components/sharing/PendingShareInvites.tsx', () => ({ default: () => <div>shared with you</div> }));
vi.mock('../components/sharing/AccessRequestRow.tsx', () => ({
  default: ({ entry }: { entry: DappAccessRequestEntry }) => <div data-request>{entry.displayName}{entry.rejoin ? ' (rejoin)' : ''}</div>,
}));
vi.mock('../components/DappContent.tsx', () => ({ DappContent: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import ShareInvitePage from '../pages/ShareInvitePage.tsx';
import RequestsInbox from '../components/sharing/RequestsInbox.tsx';
import { approvableAccessRequests, countAccessRequestsByDapp } from '../hooks/useRequestsInbox.ts';

function request(dappId: string, displayName: string, extra: Partial<DappAccessRequestEntry> = {}): DappAccessRequestEntry {
  return {
    dappId, dappName: 'Shopping', dappIcon: '🛒', inviteId: 'inv', publicKey: `${dappId}-${displayName}`,
    displayName, safetyNumber: '12345678', lobbyId: 'dapp-lobby-test', autoApprove: false, rejoin: false, awaitingConfirmation: false, ...extra,
  };
}

describe('Share & invite page and the Requests inbox', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.role = 'owner';
    mocks.shares = [];
    mocks.accessRequests = [];
    mocks.pairingRequests = [];
    mocks.pendingInvites = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderSharePage = () => act(() => root.render(
    <MemoryRouter initialEntries={['/dapp/d1/share']}>
      <Routes><Route path="/dapp/:id/share" element={<ShareInvitePage />} /></Routes>
    </MemoryRouter>,
  ));

  it('gives an owner invites, members and only this app’s waiting devices on one page', () => {
    mocks.accessRequests = [request('d1', 'Mia phone'), request('d1', 'NAS Keeper', { rejoin: true }), request('other', 'Stranger')];
    renderSharePage();
    expect(container.textContent).toContain('Shopping · Share & invite');
    expect(container.textContent).toContain('invites panel');
    expect(container.textContent).toContain('members list');
    expect(Array.from(container.querySelectorAll('[data-request]')).map((node) => node.textContent)).toEqual(['Mia phone', 'NAS Keeper (rejoin)']);
    // Shares with contacts only show for an app whose manifest declares any.
    expect(container.textContent).not.toContain('active shares of');
  });

  it('shows what is shared with contacts when the app declares shares, and hides the waiting section when nobody waits', () => {
    mocks.shares = [{ id: 'progress' }];
    renderSharePage();
    expect(container.textContent).toContain('active shares of d1');
    expect(container.textContent).not.toContain('Waiting for approval');
  });

  it('is closed to everyone but owners', () => {
    mocks.role = 'editor';
    renderSharePage();
    expect(container.textContent).toContain('Only owners can invite people');
    expect(container.textContent).not.toContain('invites panel');
  });

  it('tells you that nothing is waiting instead of rendering an empty inbox', () => {
    act(() => root.render(<MemoryRouter><RequestsInbox /></MemoryRouter>));
    expect(container.textContent).toContain('Nothing is waiting');
  });

  it('lists waiting devices with a way to their app’s Share & invite page', () => {
    mocks.accessRequests = [request('d1', 'Mia phone')];
    act(() => root.render(<MemoryRouter><RequestsInbox /></MemoryRouter>));
    expect(container.textContent).toContain('Devices waiting');
    expect(container.querySelector('a[href="/dapp/d1/share"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Nothing is waiting');
  });

  it('counts only devices a person has to decide on — a 1-step invite admits its devices by itself', () => {
    const entries = [request('d1', 'a'), request('d1', 'b', { autoApprove: true }), request('d2', 'c'), request('d2', 'd', { rejoin: true })];
    expect(approvableAccessRequests(entries).map((entry) => entry.displayName)).toEqual(['a', 'c', 'd']);
    expect(countAccessRequestsByDapp(entries)).toEqual({ d1: 1, d2: 2 });
  });
});
