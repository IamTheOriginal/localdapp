import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  archiveDappCatalogEntry,
  disconnectDappNetwork,
  getDappCredentials,
  getDappsList,
} from '../services/store/docs.ts';

function addCatalogEntry(fields: Record<string, string>): void {
  const item = new Y.Map<string>();
  Object.entries(fields).forEach(([key, value]) => item.set(key, value));
  getDappsList().push([item]);
}

function catalogItem(dappId: string): Y.Map<string> | null {
  const list = getDappsList();
  for (let i = 0; i < list.length; i++) {
    if (list.get(i).get('id') === dappId) return list.get(i);
  }
  return null;
}

describe('archiveDappCatalogEntry', () => {
  it('stamps archivedAt and scrubs every room/lobby credential', () => {
    addCatalogEntry({
      id: 'archived-dapp',
      name: 'Left app',
      roomId: 'room-1',
      roomPassword: 'secret',
      roomEpoch: '3',
      lobbyId: 'lobby-1',
      lobbyPassword: 'lobby-secret',
      grantedBy: 'ff'.repeat(32),
      joinMethod: 'lobby',
    });

    expect(archiveDappCatalogEntry('archived-dapp')).toBe(true);

    const item = catalogItem('archived-dapp');
    expect(item).not.toBeNull();
    if (!item) return;
    expect(Date.parse(item.get('archivedAt') || '')).not.toBeNaN();
    for (const key of ['roomId', 'roomPassword', 'roomEpoch', 'lobbyId', 'lobbyPassword', 'grantedBy']) {
      expect(item.get(key), key).toBeUndefined();
    }
    // Identity/name survive so the archive stays presentable.
    expect(item.get('name')).toBe('Left app');
    expect(item.get('joinMethod')).toBe('lobby');
    expect(getDappCredentials('archived-dapp')).toEqual({ roomId: '', roomPassword: '', epoch: 0 });
  });

  it('returns false for an unknown dapp', () => {
    expect(archiveDappCatalogEntry('missing-dapp')).toBe(false);
  });
});

describe('disconnectDappNetwork', () => {
  it('is safe when no providers were ever created', () => {
    expect(() => disconnectDappNetwork('never-connected')).not.toThrow();
  });
});
