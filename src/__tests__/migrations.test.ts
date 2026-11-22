import { describe, expect, it, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import {
  CURRENT_DAPP_DOC_VERSION,
  DAPP_DOC_MIGRATIONS,
  getDappDocVersion,
  runDappDocMigrations,
} from '../services/store/migrations.ts';

const stampCurrent = (doc: Y.Doc) => doc.getMap('config').set('docVersion', CURRENT_DAPP_DOC_VERSION);

afterEach(() => {
  DAPP_DOC_MIGRATIONS.length = 0;
});

describe('dapp doc versioning', () => {
  it('treats docs without a version field as version 0', () => {
    const doc = new Y.Doc();
    expect(getDappDocVersion(doc)).toBe(0);
    doc.getMap('config').set('docVersion', 'garbage');
    expect(getDappDocVersion(doc)).toBe(0);
  });

  it('stamps unversioned docs to the current version without touching content', () => {
    const doc = new Y.Doc();
    doc.getMap('config').set('meta', 'x');
    expect(runDappDocMigrations(doc)).toBe(0);
    expect(getDappDocVersion(doc)).toBe(CURRENT_DAPP_DOC_VERSION);
    expect(doc.getMap('config').get('meta')).toBe('x');
  });

  it('is a no-op on an already-current doc', () => {
    const doc = new Y.Doc();
    stampCurrent(doc);
    const before = Y.encodeStateAsUpdate(doc);
    expect(runDappDocMigrations(doc)).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('runs pending migrations and stamps the final version exactly once', () => {
    const doc = new Y.Doc();
    let runs = 0;
    DAPP_DOC_MIGRATIONS.push({
      toVersion: CURRENT_DAPP_DOC_VERSION,
      migrate: (target) => { runs++; target.getMap('config').set('migrated', true); },
    });

    expect(runDappDocMigrations(doc)).toBe(1);
    expect(runs).toBe(1);
    expect(doc.getMap('config').get('migrated')).toBe(true);
    expect(getDappDocVersion(doc)).toBe(CURRENT_DAPP_DOC_VERSION);

    // Second run applies nothing.
    expect(runDappDocMigrations(doc)).toBe(0);
    expect(runs).toBe(1);
  });

  it('skips migrations at or below the doc version', () => {
    const doc = new Y.Doc();
    stampCurrent(doc);
    let runs = 0;
    DAPP_DOC_MIGRATIONS.push({ toVersion: CURRENT_DAPP_DOC_VERSION, migrate: () => { runs++; } });
    expect(runDappDocMigrations(doc)).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses to touch a doc from a newer app version', () => {
    const doc = new Y.Doc();
    doc.getMap('config').set('docVersion', CURRENT_DAPP_DOC_VERSION + 1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(runDappDocMigrations(doc)).toBe(-1);
      expect(getDappDocVersion(doc)).toBe(CURRENT_DAPP_DOC_VERSION + 1);
    } finally {
      warn.mockRestore();
    }
  });
});
