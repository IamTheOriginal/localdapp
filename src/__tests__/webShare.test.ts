import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { manifestAcceptsShare, normalizeWebShare, stagedShareRef, webShareKind } from '../services/webShare.ts';
import { parseCodeAppManifest } from '../services/codeAppManifest.ts';

const harness: { dappDocs: Map<string, Y.Doc>; role: 'owner' | 'editor' | 'viewer' | null } = {
  dappDocs: new Map(),
  role: 'owner',
};

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (id: string) => {
    let doc = harness.dappDocs.get(id);
    if (!doc) { doc = new Y.Doc(); harness.dappDocs.set(id, doc); }
    return doc;
  },
}));
vi.mock('../services/store/auth.ts', () => ({
  requireRole: vi.fn(() => {
    if (harness.role === null) throw new Error('auth: Not a member of this dapp');
    if (harness.role === 'viewer') throw new Error('auth: Viewers cannot write data');
  }),
}));

import { appendIncomingShare, INCOMING_SHARES_KEY, MAX_INCOMING_SHARES } from '../services/store/codeData.ts';

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

describe('web share normalization and eligibility', () => {
  it('normalizes title/text/url launch params', () => {
    expect(normalizeWebShare(params({}))).toBeNull();
    expect(normalizeWebShare(params({ title: 'only a title' }))).toBeNull();
    expect(normalizeWebShare(params({ text: ' hello ' }))).toEqual({ text: 'hello' });
    expect(normalizeWebShare(params({ title: 'T', url: 'https://example.com/x' })))
      .toEqual({ title: 'T', url: 'https://example.com/x' });
  });

  it('promotes a lone http(s) link in text to url and drops unsafe schemes', () => {
    expect(normalizeWebShare(params({ text: 'https://example.com/page' })))
      .toEqual({ url: 'https://example.com/page' });
    expect(normalizeWebShare(params({ text: 'read this: https://example.com' })))
      .toEqual({ text: 'read this: https://example.com' });
    // A non-http(s) url param is not a link; the share survives only if text remains.
    expect(normalizeWebShare(params({ url: 'javascript:alert(1)' }))).toBeNull();
    expect(normalizeWebShare(params({ url: 'javascript:alert(1)', text: 'note' }))).toEqual({ text: 'note' });
  });

  it('treats staged files as a file share and validates the staging reference', () => {
    const photo = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    expect(normalizeWebShare(params({}), [photo])).toEqual({ files: [photo] });
    expect(normalizeWebShare(params({ text: 'caption' }), [photo])).toEqual({ text: 'caption', files: [photo] });
    expect(webShareKind({ text: 'caption', files: [photo] })).toBe('files');

    expect(stagedShareRef(params({ share: '4f3a1c2e-1', files: '2' }))).toEqual({ id: '4f3a1c2e-1', count: 2 });
    expect(stagedShareRef(params({ share: '../etc', files: '2' }))).toBeNull();
    expect(stagedShareRef(params({ share: '4f3a1c2e-1', files: '0' }))).toBeNull();
    expect(stagedShareRef(params({ share: '4f3a1c2e-1', files: '500' }))?.count).toBe(20);
  });

  it('derives the share kind and matches manifests', () => {
    expect(webShareKind({ text: 'note' })).toBe('text');
    expect(webShareKind({ url: 'https://example.com' })).toBe('url');

    const manifestOf = (yaml: string) => parseCodeAppManifest(yaml).manifest;
    const textOnly = manifestOf('routes:\n  - path: /\n    label: Home\nshareTarget:\n  accepts: [text]\n');
    const urlOnly = manifestOf('routes:\n  - path: /\n    label: Home\nshareTarget:\n  accepts: [url]\n');
    const none = manifestOf('routes:\n  - path: /\n    label: Home\n');

    expect(manifestAcceptsShare(textOnly, { text: 'note' })).toBe(true);
    expect(manifestAcceptsShare(textOnly, { url: 'https://example.com' })).toBe(false);
    expect(manifestAcceptsShare(urlOnly, { url: 'https://example.com' })).toBe(true);
    expect(manifestAcceptsShare(none, { text: 'note' })).toBe(false);

    // File shares need the files opt-in AND the $files permission.
    const photo = new File([new Uint8Array([1])], 'p.png', { type: 'image/png' });
    const filesNoPermission = manifestOf('routes:\n  - path: /\n    label: Home\nshareTarget:\n  accepts: [files]\n');
    const filesWithPermission = manifestOf('routes:\n  - path: /\n    label: Home\npermissions:\n  host:\n    files: true\nshareTarget:\n  accepts: [files, text]\n');
    expect(manifestAcceptsShare(filesNoPermission, { files: [photo] })).toBe(false);
    expect(manifestAcceptsShare(filesWithPermission, { files: [photo] })).toBe(true);
    expect(manifestAcceptsShare(filesWithPermission, { text: 'caption', files: [photo] })).toBe(true);
    expect(manifestAcceptsShare(textOnly, { text: 'caption', files: [photo] })).toBe(false);
  });
});

describe('incoming share inbox ($data)', () => {
  beforeEach(() => {
    harness.dappDocs.clear();
    harness.role = 'owner';
  });

  const inbox = (dappId: string): unknown[] =>
    harness.dappDocs.get(dappId)?.getMap('appData').get(INCOMING_SHARES_KEY) as unknown[];

  it('prepends entries newest-first with caps applied', () => {
    appendIncomingShare('d1', { text: 'first' });
    const second = appendIncomingShare('d1', { title: ` T${'x'.repeat(500)} `, url: 'https://example.com' });

    const entries = inbox('d1') as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(second.id);
    expect(entries[0].url).toBe('https://example.com');
    expect((entries[0].title as string).length).toBe(256);
    expect(entries[1].text).toBe('first');
    expect(typeof entries[0].receivedAt).toBe('string');
  });

  it('caps the inbox and recovers from a clobbered value', () => {
    for (let i = 0; i < MAX_INCOMING_SHARES + 5; i += 1) {
      appendIncomingShare('d1', { text: `share ${i}` });
    }
    expect(inbox('d1')).toHaveLength(MAX_INCOMING_SHARES);
    expect((inbox('d1')[0] as Record<string, unknown>).text).toBe(`share ${MAX_INCOMING_SHARES + 4}`);

    // A Code App may overwrite the key with junk; delivery must self-heal.
    harness.dappDocs.get('d1')?.getMap('appData').set(INCOMING_SHARES_KEY, 'not an array');
    appendIncomingShare('d1', { text: 'after clobber' });
    expect(inbox('d1')).toHaveLength(1);
  });

  it('records delivered files by file id', () => {
    const entry = appendIncomingShare('d1', {
      text: 'caption',
      files: [{ fileId: 'f1', name: 'photo.jpg', mime: 'image/jpeg', size: 3 }, { fileId: '', name: 'dropped', mime: '', size: 0 }],
    });
    expect(entry.files).toEqual([{ fileId: 'f1', name: 'photo.jpg', mime: 'image/jpeg', size: 3 }]);
    expect(appendIncomingShare('d1', { files: [{ fileId: 'f2', name: 'a.pdf', mime: 'application/pdf', size: 9 }] }).text).toBeUndefined();
    expect(() => appendIncomingShare('d1', { files: [] })).toThrow(/text, a url, or files/);
  });

  it('rejects empty shares and enforces the role gate', () => {
    expect(() => appendIncomingShare('d1', { title: 'only a title' })).toThrow(/text, a url, or files/);
    harness.role = 'viewer';
    expect(() => appendIncomingShare('d1', { text: 'nope' })).toThrow(/Viewers cannot write/);
    harness.role = null;
    expect(() => appendIncomingShare('d1', { text: 'nope' })).toThrow(/Not a member/);
  });
});
