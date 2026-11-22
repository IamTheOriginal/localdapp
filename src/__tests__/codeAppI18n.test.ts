// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import {
  codeAppI18nLanguageOf,
  extractCodeAppI18n,
  validateCodeAppI18nFiles,
  MAX_CODE_APP_I18N_LANGUAGES,
} from '../services/codeAppI18n.ts';
import { validateCodeAppFiles } from '../services/store/source.ts';
import { buildCodeAppDocument } from '../services/codeAppRuntime.ts';

const MANIFEST = 'routes:\n  - path: /\n    label: Home\n';

describe('Code App i18n', () => {
  it('recognizes i18n/<language>.json paths and nothing else', () => {
    expect(codeAppI18nLanguageOf('i18n/de.json')).toBe('de');
    expect(codeAppI18nLanguageOf('i18n/PT-BR.json')).toBe('pt-br');
    expect(codeAppI18nLanguageOf('i18n/nested/de.json')).toBeNull();
    expect(codeAppI18nLanguageOf('i18n/notalanguage.json')).toBeNull();
    expect(codeAppI18nLanguageOf('i18n/de.yaml')).toBeNull();
    expect(codeAppI18nLanguageOf('de.json')).toBeNull();
  });

  it('extracts valid dictionaries and skips malformed ones without throwing', () => {
    const dictionaries = extractCodeAppI18n({
      'index.html': '<p>app</p>',
      'i18n/de.json': JSON.stringify({ Hello: 'Hallo' }),
      'i18n/fr.json': 'not json at all',
      'i18n/it.json': JSON.stringify({ Hello: 42 }),
    });
    expect(dictionaries).toEqual({ de: { Hello: 'Hallo' } });
  });

  it('keeps dangerous JSON keys as plain dictionary entries', () => {
    const dictionaries = extractCodeAppI18n({
      'i18n/de.json': JSON.stringify({ __proto__: 'x', constructor: 'y', Hello: 'Hallo' }),
    });
    expect(dictionaries.de.Hello).toBe('Hallo');
    expect(Object.getPrototypeOf(dictionaries.de)).toBe(Object.prototype);
  });

  it('validation fails closed on malformed dictionaries and bad names', () => {
    expect(() => validateCodeAppI18nFiles({ 'i18n/de.json': '{broken' })).toThrow(/not valid JSON/);
    expect(() => validateCodeAppI18nFiles({ 'i18n/de.json': '[1,2]' })).toThrow(/JSON object/);
    expect(() => validateCodeAppI18nFiles({ 'i18n/de.json': JSON.stringify({ a: 1 }) })).toThrow(/must be a string/);
    expect(() => validateCodeAppI18nFiles({ 'i18n/definitely-wrong.json': '{}' })).toThrow(/language/);
    expect(() => validateCodeAppI18nFiles({ 'i18n/de.json': JSON.stringify({ ok: 'ja' }) })).not.toThrow();
    // Non-i18n files are none of this validator's business.
    expect(() => validateCodeAppI18nFiles({ 'data/whatever.json': '{broken' })).not.toThrow();
  });

  it('rejects more than the language limit', () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_CODE_APP_I18N_LANGUAGES + 1; index++) {
      files[`i18n/${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}.json`] = '{}';
    }
    expect(() => validateCodeAppI18nFiles(files)).toThrow(/limited/);
  });

  it('is enforced by validateCodeAppFiles so editor saves and installs surface typos', () => {
    const source = { 'index.html': '<p>app</p>', 'manifest.yaml': MANIFEST };
    expect(() => validateCodeAppFiles({ ...source, 'i18n/de.json': '{nope' })).toThrow(/not valid JSON/);
    expect(() => validateCodeAppFiles({ ...source, 'i18n/de.json': JSON.stringify({ Hello: 'Hallo' }) })).not.toThrow();
  });

  it('embeds dictionaries into the built sandbox document', () => {
    const bundle = buildCodeAppDocument({
      'index.html': '<html><head></head><body><p>app</p></body></html>',
      'manifest.yaml': MANIFEST,
      'i18n/de.json': JSON.stringify({ 'New game': 'Neues Spiel' }),
    }, 'runtime-test-id');
    try {
      expect(bundle.srcdoc).toContain('Neues Spiel');
      expect(bundle.srcdoc).toContain('$i18n');
      expect(bundle.srcdoc).toContain('language-changed');
    } finally {
      bundle.dispose();
    }
  });

  it('never lets a dictionary value terminate the SDK script element', () => {
    const bundle = buildCodeAppDocument({
      'index.html': '<html><head></head><body></body></html>',
      'manifest.yaml': MANIFEST,
      'i18n/de.json': JSON.stringify({ x: '</script><script>alert(1)</script>' }),
    }, 'runtime-test-id');
    try {
      expect(bundle.srcdoc).not.toContain('</script><script>alert(1)');
    } finally {
      bundle.dispose();
    }
  });
});
