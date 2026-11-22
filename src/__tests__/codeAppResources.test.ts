import { describe, expect, it } from 'vitest';
import {
  CodeAppResourceBundler,
  getCodeAppResourceMimeType,
  resolveCodeAppResourceReference,
} from '../services/codeAppResources';

describe('Code App local resource paths', () => {
  it.each([
    ['app.js', 'index.html', { path: 'app.js', fragment: '' }],
    ['./vendor/app.js', 'index.html', { path: 'vendor/app.js', fragment: '' }],
    ['../assets/logo.svg#mark', 'styles/app.css', { path: 'assets/logo.svg', fragment: '#mark' }],
    ['./nested/../theme.css', 'pages/index.html', { path: 'pages/theme.css', fragment: '' }],
  ])('resolves %s relative to %s', (reference, fromPath, expected) => {
    expect(resolveCodeAppResourceReference(reference, fromPath)).toEqual(expected);
  });

  it.each([
    ['../../secret.js', 'pages/index.html'],
    ['/app.js', 'index.html'],
    ['//example.com/app.js', 'index.html'],
    ['https://example.com/app.js', 'index.html'],
    ['data:text/javascript,alert(1)', 'index.html'],
    ['blob:guess', 'index.html'],
    ['app%2ejs', 'index.html'],
    ['app.js?cache=1', 'index.html'],
    ['app\\evil.js', 'index.html'],
  ])('rejects unsafe reference %s', (reference, fromPath) => {
    expect(resolveCodeAppResourceReference(reference, fromPath)).toBeNull();
  });

  it('maps supported text resource MIME types', () => {
    expect(getCodeAppResourceMimeType('vendor/app.js')).toBe('text/javascript');
    expect(getCodeAppResourceMimeType('styles/app.css')).toBe('text/css');
    expect(getCodeAppResourceMimeType('assets/logo.svg')).toBe('image/svg+xml');
    expect(getCodeAppResourceMimeType('assets/photo.png')).toBeNull();
  });
});

describe('Code App image resources', () => {
  it('resolves data, vendored SVG, and allowlisted exact-origin HTTPS images', () => {
    const resources = new CodeAppResourceBundler(
      { 'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" />' },
      new Set(['https://tiles.example.com:8443']),
    );

    expect(resources.resolveImage('data:image/png;base64,AA==', 'index.html')).toBe('data:image/png;base64,AA==');
    expect(resources.resolveImage('assets/logo.svg#icon', 'index.html')).toMatch(/^data:image\/svg\+xml.*#icon$/);
    expect(resources.resolveImage('https://tiles.example.com:8443/map.png?x=1', 'index.html'))
      .toBe('https://tiles.example.com:8443/map.png?x=1');
    expect(resources.resolveImage('https://tiles.example.com/map.png', 'index.html')).toBeNull();
    expect(resources.resolveImage('http://tiles.example.com:8443/map.png', 'index.html')).toBeNull();
  });

  it('rewrites CSS image URLs through the unified resolver and still rejects imports', () => {
    const resources = new CodeAppResourceBundler({}, new Set(['https://tiles.example.com']));
    const css = resources.rewriteCss(`
      .allowed { background: url('https://tiles.example.com/a.png') }
      .unlisted { background: url(https://other.example/a.png) }
      .http { background: url("http://tiles.example.com/a.png") }
    `, 'styles/app.css');
    expect(css).toContain('url("https://tiles.example.com/a.png")');
    expect(css?.match(/url\("data:,"\)/g)).toHaveLength(2);
    expect(resources.rewriteCss(`@import url('https://tiles.example.com/app.css');`, 'index.html')).toBeNull();
  });
});
