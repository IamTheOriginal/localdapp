interface CodeAppResourceReference {
  path: string;
  fragment: string;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

/** Resolve an authored resource reference without ever consulting a URL base. */
export function resolveCodeAppResourceReference(
  reference: string,
  fromPath: string,
): CodeAppResourceReference | null {
  const hasControlCharacter = [...reference].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    !reference
    || hasControlCharacter
    || /[%\\?]/.test(reference)
    || reference.startsWith('/')
    || reference.startsWith('#')
    || /^[a-z][a-z\d+.-]*:/i.test(reference)
  ) return null;

  const hashIndex = reference.indexOf('#');
  const resourcePath = hashIndex < 0 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? '' : reference.slice(hashIndex);
  if (!resourcePath || fragment.includes('?')) return null;

  const baseParts = fromPath.split('/');
  baseParts.pop();
  for (const part of resourcePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (baseParts.length === 0) return null;
      baseParts.pop();
      continue;
    }
    baseParts.push(part);
  }

  const path = baseParts.join('/');
  return path ? { path, fragment } : null;
}

export function getCodeAppResourceMimeType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return MIME_TYPES[path.slice(dot).toLowerCase()] || null;
}

export class CodeAppResourceBundler {
  readonly #files: Readonly<Record<string, string>>;
  readonly #allowedImageOrigins: ReadonlySet<string>;
  readonly #resourceUrls = new Map<string, string>();

  constructor(files: Readonly<Record<string, string>>, allowedImageOrigins: ReadonlySet<string> = new Set()) {
    this.#files = files;
    this.#allowedImageOrigins = allowedImageOrigins;
  }

  resolveSvg(reference: string, fromPath: string): string | null {
    if (/^data:/i.test(reference)) return reference;
    const resolved = resolveCodeAppResourceReference(reference, fromPath);
    if (!resolved || getCodeAppResourceMimeType(resolved.path) !== 'image/svg+xml') return null;
    const content = this.#files[resolved.path];
    if (typeof content !== 'string') return null;
    let url = this.#resourceUrls.get(resolved.path);
    if (!url) {
      // A sandbox without allow-same-origin gets an opaque origin and cannot
      // reliably load blob URLs created by the parent Builder. Data URLs remain
      // self-contained and are restricted to images by the generated CSP.
      url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
      this.#resourceUrls.set(resolved.path, url);
    }
    return url + resolved.fragment;
  }

  resolveImage(reference: string, fromPath: string): string | null {
    const bundled = this.resolveSvg(reference, fromPath);
    if (bundled) return bundled;
    try {
      const remoteUrl = new URL(reference);
      return remoteUrl.protocol === 'https:' && this.#allowedImageOrigins.has(remoteUrl.origin)
        ? reference
        : null;
    } catch {
      return null;
    }
  }

  getScript(reference: string, fromPath: string): string | null {
    const resolved = resolveCodeAppResourceReference(reference, fromPath);
    if (!resolved || resolved.fragment || getCodeAppResourceMimeType(resolved.path) !== 'text/javascript') return null;
    const content = this.#files[resolved.path];
    return typeof content === 'string' ? content : null;
  }

  getStylesheet(reference: string, fromPath: string): string | null {
    const resolved = resolveCodeAppResourceReference(reference, fromPath);
    if (!resolved || resolved.fragment || getCodeAppResourceMimeType(resolved.path) !== 'text/css') return null;
    const content = this.#files[resolved.path];
    return typeof content === 'string' ? this.rewriteCss(content, resolved.path) : null;
  }

  rewriteCss(css: string, fromPath: string): string | null {
    // False positives are preferable to allowing an import to trigger a fetch.
    if (/@import\b/i.test(css)) return null;

    return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))\s*\)/gi, (_match, double, single, bare) => {
      const reference = String(double ?? single ?? bare ?? '');
      const url = this.resolveImage(reference, fromPath);
      return url ? `url(${JSON.stringify(url)})` : 'url("data:,")';
    });
  }

  dispose(): void {
    this.#resourceUrls.clear();
  }
}
