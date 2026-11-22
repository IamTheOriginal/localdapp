// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelShare } from '../types.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = vi.hoisted(() => ({
  shares: [] as ChannelShare[],
  revoke: vi.fn(() => Promise.resolve()),
  removeLocal: vi.fn(() => Promise.resolve()),
}));

vi.mock('../hooks/useSharing.ts', () => ({
  useChannelSharingCatalog: () => ({ shares: state.shares, pendingInvites: [] }),
}));
vi.mock('../hooks/useYjs.ts', () => ({
  useDappsList: () => [{ id: 'dapp-1', name: 'Expenses' }],
}));
vi.mock('../hooks/useRelationships.ts', () => ({
  useRelationshipCatalog: () => ({
    people: [{ id: 'person-1', displayName: 'Alice' }],
    relationships: [{ id: 'relationship-1', personId: 'person-1' }],
  }),
}));
vi.mock('../services/browserRelationshipRuntime.ts', () => ({
  revokeChannelShareParticipant: state.revoke,
  removeChannelShareLocally: state.removeLocal,
}));

import ActiveShares from '../components/sharing/ActiveShares.tsx';

function share(status: ChannelShare['status']): ChannelShare {
  return {
    id: `share-${status}`, schemaVersion: 1, dappId: 'dapp-1', shareId: 'expenses', instanceId: 'instance-1',
    relationshipId: 'relationship-1', channelId: 'channel-1', eventIds: ['expense.shared'], actionIds: ['expense.receive'],
    status, createdAt: '2026-08-21T08:00:00.000Z', updatedAt: '2026-08-21T08:00:00.000Z',
  };
}

function button(label: string): HTMLButtonElement {
  const matches = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((candidate) => candidate.textContent?.trim() === label);
  const match = matches.at(-1);
  if (!match) throw new Error(`Expected button: ${label}`);
  return match;
}

describe('ActiveShares removal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    state.shares = [];
    state.revoke.mockClear();
    state.removeLocal.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('revokes and removes an active share', async () => {
    const active = share('active');
    state.shares = [active];
    act(() => root.render(<ActiveShares />));
    act(() => button('Stop sharing').click());
    await act(async () => { button('Stop sharing').click(); await Promise.resolve(); });
    expect(state.revoke).toHaveBeenCalledWith(active);
  });

  it('revokes a pending outgoing invite instead of only hiding it locally', async () => {
    const pending = share('pending');
    state.shares = [pending];
    act(() => root.render(<ActiveShares />));
    act(() => button('Withdraw share offer').click());
    await act(async () => { button('Withdraw share offer').click(); await Promise.resolve(); });
    expect(state.revoke).toHaveBeenCalledWith(pending);
    expect(state.removeLocal).not.toHaveBeenCalled();
  });

  it('offers direct local removal for already-revoked rows', async () => {
    const revoked = share('revoked');
    state.shares = [revoked];
    act(() => root.render(<ActiveShares />));
    act(() => button('Remove').click());
    await act(async () => { button('Remove').click(); await Promise.resolve(); });
    expect(state.removeLocal).toHaveBeenCalledWith(revoked);
  });
});
