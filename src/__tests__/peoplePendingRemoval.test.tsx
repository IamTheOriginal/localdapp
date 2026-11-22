// @vitest-environment happy-dom

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PeoplePage from '../pages/PeoplePage.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = vi.hoisted(() => {
  const identity = (id: string) => ({
    id, schemaVersion: 1 as const, publicKey: `${id}-public`, encPublicKey: `${id}-enc`,
    privateKey: `${id}-private`, encPrivateKey: `${id}-enc-private`, createdAt: '2026-01-01',
  });
  return {
    removePendingRelationship: vi.fn(() => Promise.resolve()),
    removeContact: vi.fn(() => Promise.resolve()),
    catalog: {
      people: [
        { id: 'person-1', schemaVersion: 1 as const, displayName: 'Stale laptop', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        { id: 'person-2', schemaVersion: 1 as const, displayName: 'Paired friend', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ],
      relationships: [{
        id: 'relationship-1', schemaVersion: 1 as const, personId: 'person-1', status: 'pending' as const,
        localIdentity: identity('identity-1'),
        createdAt: '2026-01-01', updatedAt: '2026-01-01',
      }, {
        id: 'relationship-2', schemaVersion: 1 as const, personId: 'person-2', status: 'active' as const,
        localIdentity: identity('identity-2'), peerPublicKey: 'peer-public', pairContextId: 'pair-context',
        controlCapabilityId: 'capability-1',
        createdAt: '2026-01-01', updatedAt: '2026-01-01',
      }],
      channels: [],
    },
  };
});

vi.mock('../hooks/useRelationships.ts', () => ({
  useRelationshipCatalog: () => state.catalog,
}));
vi.mock('../services/browserRelationshipRuntime.ts', () => ({
  approveRelationshipPairing: vi.fn(),
  hostRelationshipPairing: vi.fn(),
  joinRelationshipPairing: vi.fn(),
  listHostedPairingRequests: vi.fn(() => Promise.resolve([])),
  observeHostedPairingRequests: vi.fn(() => () => undefined),
  removeContact: state.removeContact,
  removePendingRelationship: state.removePendingRelationship,
  getHostedPairingInvite: vi.fn(() => null),
  getPendingPairingKind: vi.fn(() => 'hosted' as const),
  reissueRelationshipInvite: vi.fn(),
}));
vi.mock('../services/relationshipProtocol.ts', () => ({ deriveRelationshipSafetyNumber: vi.fn(() => Promise.resolve('11111 22222')) }));
vi.mock('../components/sharing/PairContactDialog.tsx', () => ({ default: () => null }));
vi.mock('../components/sharing/ActiveShares.tsx', () => ({ default: () => null }));
vi.mock('../components/sharing/InviteLinkPanel.tsx', () => ({ default: () => null }));
vi.mock('../components/ui/dialog.tsx', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe('Contacts page removal', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    state.removePendingRelationship.mockClear();
    state.removeContact.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  it('shows a mobile-safe remove action and confirms before deleting the pending contact', async () => {
    act(() => root.render(<PeoplePage />));

    const openButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Remove pending contact'));
    expect(openButton).toBeTruthy();
    expect(openButton?.className).toContain('w-full');

    act(() => openButton?.click());
    expect(document.body.textContent).toContain('Remove this pending contact?');
    expect(document.body.textContent).toContain('Stale laptop');

    const confirmButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Remove pending contact' && button !== openButton);
    await act(async () => { confirmButton?.click(); await Promise.resolve(); });

    expect(state.removePendingRelationship).toHaveBeenCalledWith('relationship-1');
    expect(state.removeContact).not.toHaveBeenCalled();
  });

  it('offers a full removal for active contacts and warns about offline peers before deleting', async () => {
    act(() => root.render(<PeoplePage />));

    const openButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Remove contact');
    expect(openButton).toBeTruthy();

    act(() => openButton?.click());
    expect(document.body.textContent).toContain('Remove this contact?');
    expect(document.body.textContent).toContain('Paired friend');
    expect(document.body.textContent).toContain('erase request');

    const confirmButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Remove contact' && button !== openButton);
    await act(async () => { confirmButton?.click(); await Promise.resolve(); });

    expect(state.removeContact).toHaveBeenCalledWith('relationship-2');
    expect(state.removePendingRelationship).not.toHaveBeenCalled();
  });
});
