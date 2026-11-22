import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fetchGithubSource, githubCompareUrl, githubLocationUrl, isValidGithubLocation, parseGithubUrl, probeGithubLocation,
} from '../services/githubSource.ts';

const MANIFEST = 'name: Demo\nicon: "🧪"\ncolor: "#123456"\nroutes:\n  - path: /\n    label: Home\n';
const sha1 = (value: string | Uint8Array) => createHash('sha1').update(value).digest('hex');
const toBytes = (content: string | Uint8Array) => (typeof content === 'string' ? new TextEncoder().encode(content) : content);
const blobSha = (content: string | Uint8Array) => {
  const bytes = toBytes(content);
  return sha1(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}`), Buffer.from([0]), Buffer.from(bytes)]));
};

interface FakeCommit { files: Record<string, string | Uint8Array> }

/** Minimal public-GitHub double: commits by ref, recursive trees, raw file bytes — and a request log. */
function fakeGithub(refs: Record<string, FakeCommit>, options: { tamper?: string; rateLimited?: boolean; truncated?: boolean } = {}) {
  const commits = new Map<string, FakeCommit>();
  const refToCommit = new Map<string, string>();
  for (const [ref, commit] of Object.entries(refs)) {
    const commitSha = sha1(`commit:${JSON.stringify(Object.entries(commit.files).map(([path, content]) => [path, blobSha(content)]))}`);
    commits.set(commitSha, commit);
    refToCommit.set(ref, commitSha);
  }
  const treeShaOf = (commitSha: string) => sha1(`tree:${commitSha}`);
  const requests: string[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  const respond = (url: URL): Response => {
    if (options.rateLimited) return json({ message: 'rate limit' }, 403, { 'x-ratelimit-remaining': '0' });
    if (url.hostname === 'api.github.com') {
      const commitMatch = /^\/repos\/acme\/app\/commits\/(.+)$/.exec(url.pathname);
      if (commitMatch) {
        const commitSha = refToCommit.get(decodeURIComponent(commitMatch[1]));
        if (!commitSha) return json({ message: 'Not Found' }, 404);
        return json({ sha: commitSha, commit: { tree: { sha: treeShaOf(commitSha) } } });
      }
      const treeMatch = /^\/repos\/acme\/app\/git\/trees\/([0-9a-f]{40})$/.exec(url.pathname);
      const entry = treeMatch ? [...commits].find(([commitSha]) => treeShaOf(commitSha) === treeMatch[1]) : undefined;
      if (!treeMatch || !entry) return json({ message: 'Not Found' }, 404);
      const tree = Object.entries(entry[1].files).map(([path, content]) => ({
        path, type: 'blob', mode: '100644', sha: blobSha(content), size: toBytes(content).byteLength,
      }));
      return json({ sha: treeMatch[1], tree, truncated: options.truncated === true });
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      const [, owner, repo, commitSha, ...pathParts] = url.pathname.split('/');
      const path = pathParts.map(decodeURIComponent).join('/');
      const content = owner === 'acme' && repo === 'app' ? commits.get(commitSha)?.files[path] : undefined;
      if (content === undefined) return new Response('missing', { status: 404 });
      return new Response(path === options.tamper ? 'tampered' : Buffer.from(toBytes(content)));
    }
    return new Response('unexpected host', { status: 500 });
  };

  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url.href);
    return Promise.resolve(respond(url));
  }) as typeof fetch;
  return { fetchImpl, requests, commitOf: (ref: string) => refToCommit.get(ref) ?? '' };
}

describe('parseGithubUrl', () => {
  it('accepts repository, folder and file links', () => {
    expect(parseGithubUrl('https://github.com/acme/app')).toEqual([{ owner: 'acme', repo: 'app', ref: '', path: '' }]);
    expect(parseGithubUrl('github.com/acme/app.git/')).toEqual([{ owner: 'acme', repo: 'app', ref: '', path: '' }]);
    expect(parseGithubUrl('https://github.com/acme/app/tree/main')).toEqual([{ owner: 'acme', repo: 'app', ref: 'main', path: '' }]);
    expect(parseGithubUrl('https://github.com/acme/app/blob/main/apps/todo/index.html')[0]).toEqual({ owner: 'acme', repo: 'app', ref: 'main', path: 'apps/todo' });
  });

  it('returns every plausible ref/folder split for slash-containing branch names', () => {
    expect(parseGithubUrl('https://github.com/acme/app/tree/feature/x/apps')).toEqual([
      { owner: 'acme', repo: 'app', ref: 'feature', path: 'x/apps' },
      { owner: 'acme', repo: 'app', ref: 'feature/x', path: 'apps' },
      { owner: 'acme', repo: 'app', ref: 'feature/x/apps', path: '' },
    ]);
  });

  it('rejects anything that is not a public github.com repository link', () => {
    for (const link of ['', 'https://gitlab.com/acme/app', 'http://github.com/acme/app', 'https://github.com/acme', 'https://github.com/acme/app/issues/3',
      'https://github.com/acme/app/tree/main/a%5Cb', 'https://evil.example/github.com/acme/app', 'javascript:alert(1)']) {
      expect(() => parseGithubUrl(link), link).toThrow(/^github: /);
    }
  });

  it('refuses dot-only owner or repository names (they would climb to another API path)', () => {
    for (const [owner, repo] of [['..', 'app'], ['acme', '..'], ['.', 'app'], ['acme', '.']]) {
      expect(isValidGithubLocation({ owner, repo, ref: 'main', path: '' }), `${owner}/${repo}`).toBe(false);
    }
    expect(isValidGithubLocation({ owner: 'acme', repo: '.github', ref: '', path: '' })).toBe(true);
  });

  it('builds links back to GitHub', () => {
    const location = { owner: 'acme', repo: 'app', ref: '', path: 'apps/todo' };
    expect(githubLocationUrl({ ...location, path: '' })).toBe('https://github.com/acme/app');
    expect(githubLocationUrl(location, 'abc')).toBe('https://github.com/acme/app/tree/abc/apps/todo');
    expect(githubCompareUrl(location, 'aaa', 'bbb')).toBe('https://github.com/acme/app/compare/aaa...bbb');
  });
});

describe('fetchGithubSource', () => {
  const files = {
    'index.html': '<!doctype html><title>Demo</title>',
    'manifest.yaml': MANIFEST,
    'app/main.js': 'console.log("hi")',
    'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]),
    '.github/workflows/ci.yml': 'on: push',
    'README.md': '# Demo',
  };

  it('copies the text sources of the default branch, pinned to one commit and verified per file', async () => {
    const github = fakeGithub({ HEAD: { files } });
    const snapshot = await fetchGithubSource('https://github.com/acme/app', github.fetchImpl);
    expect(snapshot.location).toEqual({ owner: 'acme', repo: 'app', ref: '', path: '' });
    expect(snapshot.commitSha).toBe(github.commitOf('HEAD'));
    expect(snapshot.files).toEqual({ 'index.html': files['index.html'], 'manifest.yaml': MANIFEST, 'app/main.js': files['app/main.js'] });
    expect(snapshot.skipped).toEqual(['.github/workflows/ci.yml', 'README.md', 'logo.png']);
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Content is always fetched at the pinned commit, never at a moving branch name.
    const rawRequests = github.requests.filter((entry) => entry.includes('raw.githubusercontent.com'));
    expect(rawRequests).toHaveLength(3);
    for (const url of rawRequests) expect(url).toContain(`/${snapshot.commitSha}/`);
  });

  it('installs a subfolder and resolves branch names that contain slashes', async () => {
    const github = fakeGithub({ 'feature/x': { files: { 'apps/todo/index.html': 'a', 'apps/todo/manifest.yaml': MANIFEST, 'other/index.html': 'b' } } });
    const snapshot = await fetchGithubSource('https://github.com/acme/app/tree/feature/x/apps/todo', github.fetchImpl);
    expect(snapshot.location).toEqual({ owner: 'acme', repo: 'app', ref: 'feature/x', path: 'apps/todo' });
    expect(Object.keys(snapshot.files).sort()).toEqual(['index.html', 'manifest.yaml']);
  });

  it('fails closed on tampered content, missing app files, private repositories, oversized listings and rate limits', async () => {
    await expect(fetchGithubSource('https://github.com/acme/app', fakeGithub({ HEAD: { files } }, { tamper: 'app/main.js' }).fetchImpl))
      .rejects.toThrow('app/main.js does not match the repository listing');
    await expect(fetchGithubSource('https://github.com/acme/app', fakeGithub({ HEAD: { files: { 'index.html': 'a' } } }).fetchImpl))
      .rejects.toThrow('No manifest.yaml in the repository root');
    await expect(fetchGithubSource('https://github.com/acme/private', fakeGithub({ HEAD: { files } }).fetchImpl))
      .rejects.toThrow('only public repositories can be added');
    await expect(fetchGithubSource('https://github.com/acme/app', fakeGithub({ HEAD: { files } }, { truncated: true }).fetchImpl))
      .rejects.toThrow('too large to list');
    await expect(fetchGithubSource('https://github.com/acme/app', fakeGithub({ HEAD: { files } }, { rateLimited: true }).fetchImpl))
      .rejects.toThrow('rate limit');
    const binaryManifest = { ...files, 'manifest.yaml': new Uint8Array([0xff, 0xfe, 0x00]) };
    await expect(fetchGithubSource('https://github.com/acme/app', fakeGithub({ HEAD: { files: binaryManifest } }).fetchImpl))
      .rejects.toThrow('not a UTF-8 text file');
  });
});

describe('probeGithubLocation', () => {
  const location = { owner: 'acme', repo: 'app', ref: 'main', path: 'apps/todo' };
  const base = { 'apps/todo/index.html': 'v1', 'apps/todo/manifest.yaml': MANIFEST, 'docs/notes.txt': 'n1' };

  it('spends one request and reports nothing while the commit is unchanged', async () => {
    const github = fakeGithub({ main: { files: base } });
    expect(await probeGithubLocation(location, github.commitOf('main'), github.fetchImpl)).toBeNull();
    expect(github.requests).toHaveLength(1);
  });

  it('keeps the fingerprint when only files outside the app folder changed, and changes it otherwise', async () => {
    const installed = await fetchGithubSource('https://github.com/acme/app/tree/main/apps/todo', fakeGithub({ main: { files: base } }).fetchImpl);

    const unrelated = fakeGithub({ main: { files: { ...base, 'docs/notes.txt': 'n2' } } });
    const sameApp = await probeGithubLocation(location, installed.commitSha, unrelated.fetchImpl);
    expect(sameApp?.commitSha).not.toBe(installed.commitSha);
    expect(sameApp?.fingerprint).toBe(installed.fingerprint);
    expect(unrelated.requests.some((url) => url.includes('raw.githubusercontent.com'))).toBe(false); // a probe never downloads sources

    const changed = await probeGithubLocation(location, installed.commitSha, fakeGithub({ main: { files: { ...base, 'apps/todo/index.html': 'v2' } } }).fetchImpl);
    expect(changed?.fingerprint).not.toBe(installed.fingerprint);
  });
});
