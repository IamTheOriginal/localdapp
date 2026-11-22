// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSignalingUrls, fetchDynamicIceServers, getDeviceIceServers, getDeviceSignalingUrls,
  resetDynamicIceServersForTests, setDeviceIceServers, setDeviceSignalingUrls,
} from '../services/signalingConfig.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Settings → Signaling: the device-local signaling server list. The panel is
 * the place where the one rule has to be visible — two devices only find each
 * other if they share at least one server — so the wording is asserted here,
 * not only the mechanics.
 */

const links = vi.hoisted(() => ({ current: [] as Array<{ url: string; connected: boolean }> }));

// The real module pulls in the WebRTC stack; the panel only reads link status from it.
vi.mock('../services/blobRoomManager.ts', () => ({
  getBrokerLinkStatus: () => links.current,
}));

import SignalingSettings from '../components/settings/SignalingSettings.tsx';

const BUILD_DEFAULT = defaultSignalingUrls()[0];

function text(): string {
  return document.body.textContent ?? '';
}

function rows(): string[] {
  return Array.from(document.querySelectorAll('li')).map((row) => row.querySelector('span.font-mono')?.textContent ?? '');
}

function buttonWith(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(label));
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

describe('SignalingSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(<SignalingSettings />);
      await Promise.resolve();
    });
  };

  const type = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('#signaling-url');
    if (!input) throw new Error('no signaling url input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
  };

  const click = async (label: string) => {
    await act(async () => {
      buttonWith(label).click();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    setDeviceSignalingUrls([]);
    setDeviceIceServers([]);
    resetDynamicIceServersForTests();
    links.current = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setDeviceSignalingUrls([]);
    setDeviceIceServers([]);
    resetDynamicIceServersForTests();
    vi.clearAllMocks();
  });

  it('shows the effective list with the build default and the consequence of changing it', async () => {
    links.current = [{ url: BUILD_DEFAULT, connected: true }];
    await render();

    expect(rows()).toEqual([BUILD_DEFAULT]);
    expect(text()).toContain('Two devices only find each other if they share at least one signaling server.');
    expect(text()).toContain('built in'); // the build default is marked, once
    expect(text()).toContain('connected');
    // Nothing to reset while the device uses the default.
    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.includes('Use the default servers'))).toBe(false);
  });

  it('adds a server next to the default instead of replacing it', async () => {
    await render();
    await type('wss://mine.example');
    await click('Add');

    expect(rows()).toEqual([BUILD_DEFAULT, 'wss://mine.example']);
    expect(getDeviceSignalingUrls()).toEqual([BUILD_DEFAULT, 'wss://mine.example']);
    expect(text()).toContain('Added. This device now also looks for peers there.');
    // Still on the default, so no "cut off" warning.
    expect(text()).not.toContain('You will only meet devices that use one of the servers above.');
  });

  it('warns once the build default is gone, and shows which entries are connected', async () => {
    await render();
    await type('wss://mine.example');
    await click('Add');

    links.current = [{ url: BUILD_DEFAULT, connected: true }, { url: 'wss://mine.example', connected: false }];
    const remove = document.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${BUILD_DEFAULT}"]`);
    if (!remove) throw new Error('no remove button for the default entry');
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });

    expect(rows()).toEqual(['wss://mine.example']);
    expect(text()).toContain('This device no longer uses the server this app was built with.');
    expect(text()).toContain('not connected');
  });

  it('refuses anything that is not a ws:// or wss:// address', async () => {
    await render();
    await type('https://signal.example.com');
    await click('Add');

    expect(text()).toContain('A signaling address must start with ws:// or wss://.');
    expect(getDeviceSignalingUrls()).toEqual([]);

    await type('wss://mine.example');
    await click('Add');
    await type('wss://mine.example');
    await click('Add');
    expect(text()).toContain('That server is already in the list.');
    expect(getDeviceSignalingUrls()).toEqual([BUILD_DEFAULT, 'wss://mine.example']);
  });

  it('goes back to the build default and says the change needs no reload', async () => {
    await render();
    await type('wss://mine.example');
    await click('Add');
    expect(text()).toContain('this device connects to the new set without a reload');

    await click('Use the default servers');
    expect(getDeviceSignalingUrls()).toEqual([]);
    expect(rows()).toEqual([BUILD_DEFAULT]);
  });

  it('keeps at least one server: the last entry cannot be removed', async () => {
    await render();
    const remove = document.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${BUILD_DEFAULT}"]`);
    expect(remove?.disabled).toBe(true);
  });

  it('lets a user configure custom TURN / ICE servers and displays monthly free relay quota', async () => {
    // Seed a quota-exceeded built-in TURN status via fetchDynamicIceServers.
    await fetchDynamicIceServers('https://app.localdapp.workers.dev/ice', {
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        ttl: 1800,
        turn: {
          active: false,
          reason: 'user_quota_exceeded',
          usedBytes: 10 * 1024 * 1024,
          limitBytes: 10 * 1024 * 1024,
          month: '2026-11',
          analyticsSynced: true,
        },
      }), { status: 200 })),
    });

    await render();
    expect(text()).toContain('Relay servers (TURN / ICE)');
    expect(text()).toContain('Monthly limit reached');
    expect(text()).toContain('10 MB / 10 MB used this month (2026-11)');

    const setInput = async (selector: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(selector);
      if (!input) throw new Error(`no input ${selector}`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      await act(async () => {
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
    };

    // Rejects non-STUN/TURN scheme.
    await setInput('#ice-server-url', 'https://turn.example.com');
    await click('Add relay server');
    expect(text()).toContain('A TURN / ICE address must start with stun:, stuns:, turn:, or turns:.');
    expect(getDeviceIceServers()).toEqual([]);

    // Adds valid custom TURN server with credentials (credential value never printed in plaintext).
    await setInput('#ice-server-url', 'turns:turn.example.com:5349?transport=tcp');
    await setInput('#ice-server-username', 'alice');
    await setInput('#ice-server-credential', 'super-secret-pass');
    await click('Add relay server');

    expect(getDeviceIceServers()).toEqual([
      { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'alice', credential: 'super-secret-pass' },
    ]);
    expect(text()).toContain('Using your own relay server');
    expect(text()).toContain('turns:turn.example.com:5349?transport=tcp');
    expect(text()).toContain('Has credential');
    expect(text()).not.toContain('super-secret-pass');

    await click('Use built-in relay');
    expect(getDeviceIceServers()).toEqual([]);
  });

  it('hides the monthly quota bar when shared TURN is unconfigured (STUN-only)', async () => {
    await fetchDynamicIceServers('https://app.localdapp.workers.dev/ice', {
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        ttl: 3600,
        turn: {
          active: false,
          reason: 'unconfigured',
          usedBytes: 0,
          limitBytes: 10 * 1024 * 1024,
          month: '2026-11',
          analyticsSynced: false,
        },
      }), { status: 200 })),
    });

    await render();
    expect(text()).toContain('STUN only');
    expect(text()).toContain('No shared TURN relay is configured');
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });
});
