// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeAppDefinitionBundle } from '../types.ts';

const mocks = vi.hoisted(() => ({
  destroyed: 0,
  exportDefinitionBundle: vi.fn(),
  verifyDefinitionBundle: vi.fn(),
}));

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    destroy() { mocks.destroyed += 1; }
  },
}));
vi.mock('../services/store/definitionBundle.ts', () => ({
  exportDefinitionBundle: mocks.exportDefinitionBundle,
  verifyDefinitionBundle: mocks.verifyDefinitionBundle,
}));
vi.mock('../services/store/docs.ts', () => ({ generateRoomPassword: () => 'a'.repeat(64) }));
vi.mock('../services/signalingConfig.ts', () => ({ signalingEndpoints: () => ['wss://signal.example'], webrtcPeerOpts: () => ({}) }));

const bundle: CodeAppDefinitionBundle = {
  protocol: 'code-app-definition', schemaVersion: 1, name: 'Shared app', icon: '📦', color: '#123456',
  files: { 'index.html': '<main>Shared</main>', 'manifest.yaml': 'name: Shared app' },
  manifestVersion: '12345678', createdAt: '2026-09-26T10:00:00.000Z', authorPublicKey: 'b'.repeat(64), signature: 'c'.repeat(128),
};

const sourceShare = await import('../services/sourceShare.ts');

describe('source-share capabilities', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.destroyed = 0;
    mocks.exportDefinitionBundle.mockReset().mockResolvedValue(bundle);
    mocks.verifyDefinitionBundle.mockReset().mockResolvedValue(bundle);
  });

  afterEach(() => {
    for (const share of sourceShare.listSourceShares()) sourceShare.removeSourceShare(share.id);
    vi.useRealTimers();
  });

  it('creates a reusable 24-hour source-only link and removes its room', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T12:00:00.000Z'));

    const share = await sourceShare.createSourceShare('dapp-1');
    const link = sourceShare.sourceShareLink(share, 'https://dapp.example.com');

    expect(link).toMatch(/^https:\/\/dapp\.example\.com\/import#code=/);
    expect(decodeURIComponent(link.split('#code=')[1])).toContain('dapp://share/source/');
    expect(share.expiresAt).toBe('2026-09-27T12:00:00.000Z');
    expect(sourceShare.listSourceShares('dapp-1')).toHaveLength(1);

    expect(sourceShare.removeSourceShare(share.id)).toBe(true);
    expect(sourceShare.listSourceShares('dapp-1')).toHaveLength(0);
    expect(mocks.destroyed).toBe(1);
  });

  it('rejects expired and malformed recipient capabilities before opening a room', () => {
    expect(() => sourceShare.receiveSourceShare('not-a-source-link')).toThrow('invalid');
    expect(() => sourceShare.receiveSourceShare(`dapp://share/source/room/${'a'.repeat(64)}/2020-01-01T00%3A00%3A00.000Z`)).toThrow('expired');
    expect(mocks.destroyed).toBe(0);
  });
});
