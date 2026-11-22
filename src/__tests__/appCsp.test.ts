import { describe, expect, it } from 'vitest';
import appHtml from '../../index.html?raw';

describe('Builder document CSP', () => {
  it('does not veto manifest-authorized HTTPS images in srcdoc Code Apps', () => {
    const policy = appHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';

    expect(policy).toMatch(/(?:^|;\s*)img-src\s+[^;]*\bhttps:/);
  });
});
