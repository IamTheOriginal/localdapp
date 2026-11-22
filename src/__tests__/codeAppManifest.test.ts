import { describe, expect, it } from 'vitest';
import {
  splitCodeAppNavigationTarget,
  DEFAULT_CODE_APP_MANIFEST,
  LEGACY_CODE_APP_MANIFEST,
  codeAppFullscreenRouteUrl,
  codeAppRouteUrl,
  normalizeCodeAppRoutePath,
  parseCodeAppManifest,
  serializeCodeAppManifest,
} from '../services/codeAppManifest.ts';

describe('Code App manifest', () => {
  it('accepts and normalizes valid routes', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      name: 'Tasks',
      routes: [
        { path: '/', label: 'Overview', icon: 'home' },
        { path: 'tasks/', label: 'Tasks', icon: 'list' },
      ],
    }));

    expect(result.error).toBeNull();
    expect(result.manifest).toEqual({
      name: 'Tasks',
      routes: [
        { path: '/', label: 'Overview', icon: 'home' },
        { path: '/tasks', label: 'Tasks', icon: 'list' },
      ],
    });
  });

  it('parses the shareTarget opt-in', () => {
    const route = { path: '/', label: 'Home' };
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [route],
      shareTarget: { accepts: ['text', 'url'] },
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.shareTarget).toEqual({ accepts: ['text', 'url'] });

    expect(parseCodeAppManifest(JSON.stringify({ routes: [route] })).manifest.shareTarget).toBeUndefined();
    expect(parseCodeAppManifest(JSON.stringify({ routes: [route], shareTarget: { accepts: [] } })).error).toMatch(/non-empty array/);
    expect(parseCodeAppManifest(JSON.stringify({ routes: [route], shareTarget: { accepts: ['files'] } })).manifest.shareTarget).toEqual({ accepts: ['files'] });
    expect(parseCodeAppManifest(JSON.stringify({ routes: [route], shareTarget: { accepts: ['images'] } })).error).toMatch(/one of text, url, files/);
    expect(parseCodeAppManifest(JSON.stringify({ routes: [route], shareTarget: { accepts: ['text', 'text'] } })).error).toMatch(/duplicate/);
    expect(parseCodeAppManifest(JSON.stringify({ routes: [route], shareTarget: { accepts: ['text'], extra: true } })).error).toMatch(/Unknown manifest shareTarget key/);
    expect(parseCodeAppManifest(JSON.stringify({ routes: [route], shareTarget: ['text'] })).error).toMatch(/must be an object/);
  });

  it('accepts and normalizes exact HTTPS network origins', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Map' }],
      permissions: {
        network: {
          connect: [' HTTPS://API.Example.com:443 ', 'https://tiles.example.com:8443'],
          images: ['https://CDN.Example.com/'],
        },
      },
    }));

    expect(result.error).toBeNull();
    expect(result.manifest.permissions).toEqual({
      network: {
        connect: ['https://api.example.com', 'https://tiles.example.com:8443'],
        images: ['https://cdn.example.com'],
      },
    });
  });

  it('omits empty and absent network permissions', () => {
    const route = { path: '/', label: 'Offline' };
    expect(parseCodeAppManifest(JSON.stringify({ routes: [route] })).manifest).toEqual({ routes: [route] });
    expect(parseCodeAppManifest(JSON.stringify({
      routes: [route],
      permissions: { network: { connect: [], images: [] } },
    })).manifest).toEqual({ routes: [route] });
  });

  it.each([
    [['https://example.com', 'https://EXAMPLE.com:443/'], /duplicate/i],
    [['http://example.com'], /HTTPS/i],
    [['https://user:pass@example.com'], /credentials/i],
    [['https://example.com/tiles'], /path/i],
    [['https://example.com?token=one'], /query/i],
    [['https://example.com/#tiles'], /fragment/i],
    [['not a URL'], /HTTPS origin/i],
    [['https://example.com?'], /HTTPS origin/i],
    [['https://example.com#'], /HTTPS origin/i],
    [['https://@example.com'], /HTTPS origin/i],
    [['https://example.com/foo/..'], /HTTPS origin/i],
    [['https://example.com/%2e%2e/'], /HTTPS origin/i],
    [['https://example.com:'], /HTTPS origin/i],
  ])('rejects invalid connect origins: %j', (connect, expectedError) => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Map' }],
      permissions: { network: { connect } },
    }));
    expect(result.error).toMatch(expectedError);
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('rejects malformed and oversized permission values', () => {
    const base = { routes: [{ path: '/', label: 'Map' }] };
    for (const permissions of [
      null,
      [],
      { network: null },
      { network: [] },
      { network: { connect: 'https://example.com' } },
      { network: { images: [42] } },
      { network: { images: Array.from({ length: 33 }, (_, index) => `https://img${index}.example`) } },
    ]) {
      const result = parseCodeAppManifest(JSON.stringify({ ...base, permissions }));
      expect(result.error).not.toBeNull();
      expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
    }
  });

  it.each([
    { typo: true },
    { network: {}, typo: true },
    { network: { connect: [], typo: true } },
  ])('rejects unknown permission keys: %j', (permissions) => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Map' }],
      permissions,
    }));
    expect(result.error).toMatch(/unknown/i);
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('accepts the files host permission and rejects unknown host keys', () => {
    const granted = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Gallery' }],
      permissions: { host: { files: true } },
    }));
    expect(granted.error).toBeNull();
    expect(granted.manifest.permissions).toEqual({ host: { files: true } });

    // false grants are dropped entirely
    const denied = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Gallery' }],
      permissions: { host: { files: false } },
    }));
    expect(denied.error).toBeNull();
    expect(denied.manifest.permissions).toBeUndefined();

    const unknown = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Gallery' }],
      permissions: { host: { filez: true } },
    }));
    expect(unknown.error).toMatch(/unknown host permission/i);
  });

  it('accepts the camera device permission and rejects malformed device permissions', () => {
    const granted = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Scanner' }],
      permissions: { device: { camera: true } },
    }));
    expect(granted.error).toBeNull();
    expect(granted.manifest.permissions).toEqual({ device: { camera: true } });

    const denied = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Scanner' }],
      permissions: { device: { camera: false } },
    }));
    expect(denied.error).toBeNull();
    expect(denied.manifest.permissions).toBeUndefined();

    for (const device of [{ camera: 'true' }, { microphone: true }]) {
      const result = parseCodeAppManifest(JSON.stringify({
        routes: [{ path: '/', label: 'Scanner' }],
        permissions: { device },
      }));
      expect(result.error).not.toBeNull();
      expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
    }
  });

  it('accepts db index declarations and rejects malformed ones', () => {
    const parsed = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      db: { indexes: [{ collection: 'recipes', field: 'category' }, { collection: 'recipes', field: 'calories' }] },
    }));
    expect(parsed.error).toBeNull();
    expect(parsed.manifest.db?.indexes).toHaveLength(2);

    for (const db of [
      [],
      { indexes: 'nope' },
      { indexes: [{ collection: 'recipes' }] },
      { indexes: [{ collection: 'Recipes', field: 'x' }] },
      { indexes: [{ collection: 'recipes', field: 'a b' }] },
      { indexes: [{ collection: 'recipes', field: 'x' }, { collection: 'recipes', field: 'x' }] },
      { indexes: [{ collection: 'recipes', field: 'x', extra: 1 }] },
      { typo: [] },
    ]) {
      expect(parseCodeAppManifest(JSON.stringify({ routes: [{ path: '/', label: 'Home' }], db })).error).not.toBeNull();
    }
  });

  it('splits navigation targets into route path and sanitized search', () => {
    expect(splitCodeAppNavigationTarget('/recipe?id=abc-123')).toEqual({ path: '/recipe', search: '?id=abc-123' });
    expect(splitCodeAppNavigationTarget('/recipe')).toEqual({ path: '/recipe', search: '' });
    expect(splitCodeAppNavigationTarget('/recipe?')).toEqual({ path: '/recipe', search: '' });
    expect(splitCodeAppNavigationTarget('/recipe?id=a&x=b c#frag')).toEqual({ path: '/recipe', search: '?id=a&x=b+c' });
    expect(() => splitCodeAppNavigationTarget('https://evil.example/?x=1')).toThrow(/Invalid path/);
    expect(() => splitCodeAppNavigationTarget(`/recipe?x=${'a'.repeat(3000)}`)).toThrow(/limited/);
  });

  it('rejects malformed, duplicate, and unsafe routes', () => {
    expect(parseCodeAppManifest('{').error).toMatch(/valid YAML/i);
    expect(parseCodeAppManifest(JSON.stringify({ routes: [
      { path: '/tasks', label: 'One' },
      { path: 'tasks', label: 'Two' },
    ] })).error).toMatch(/duplicate/i);
    expect(parseCodeAppManifest(JSON.stringify({ routes: [
      { path: '/../admin', label: 'Admin' },
    ] })).error).toMatch(/invalid path/i);
  });

  it('accepts icon and color as display identity and normalizes the color', () => {
    const result = parseCodeAppManifest('name: Diary\nicon: " 📔 "\ncolor: "#B14E75"\nroutes:\n  - path: /\n    label: Home\n');
    expect(result.error).toBeNull();
    expect(result.manifest.icon).toBe('📔');
    expect(result.manifest.color).toBe('#b14e75');
  });

  it.each([
    ['icon: ""', /icon must be a non-empty string/],
    ['icon: 42', /icon must be a non-empty string/],
    [`icon: ${'x'.repeat(17)}`, /icon is too long/],
    ['color: red', /color must be a hex color/],
    ['color: "#12345"', /color must be a hex color/],
    ['color: 123', /color must be a hex color/],
  ])('rejects a bad display identity (%s)', (line, message) => {
    const result = parseCodeAppManifest(`${line}\nroutes:\n  - path: /\n    label: Home\n`);
    expect(result.error).toMatch(message);
  });

  it('uses a single root route when the manifest is absent', () => {
    const result = parseCodeAppManifest('');
    expect(result.error).toBeNull();
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('serializes a manifest as YAML that round-trips through the parser', () => {
    const result = parseCodeAppManifest(serializeCodeAppManifest(DEFAULT_CODE_APP_MANIFEST));
    expect(result.error).toBeNull();
    expect(result.manifest).toEqual(DEFAULT_CODE_APP_MANIFEST);
  });

  it('still accepts JSON manifests — YAML 1.2 is a superset', () => {
    const result = parseCodeAppManifest(JSON.stringify(DEFAULT_CODE_APP_MANIFEST));
    expect(result.error).toBeNull();
    expect(result.manifest).toEqual(DEFAULT_CODE_APP_MANIFEST);
  });

  it('keeps YAML 1.1 booleans as strings (core schema, no Norway problem)', () => {
    const result = parseCodeAppManifest('routes:\n  - path: /\n    label: no\n');
    expect(result.error).toBeNull();
    expect(result.manifest.routes[0].label).toBe('no');
  });

  it('accepts normalized direct event and action declarations', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      bindings: {
        events: [{ id: 'recipe.meal-planned', label: ' Meal planned ', description: ' A meal was planned. ' }],
        actions: [{ id: 'meal-plan.add', label: 'Add meal' }],
      },
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.bindings).toEqual({
      events: [{ id: 'recipe.meal-planned', label: 'Meal planned', description: 'A meal was planned.' }],
      actions: [{ id: 'meal-plan.add', label: 'Add meal' }],
    });
  });

  it.each([
    { bindings: [] },
    { bindings: { events: 'wrong' } },
    { bindings: { events: [{ id: 'Uppercase', label: 'Bad' }] } },
    { bindings: { events: [{ id: 'same', label: 'One' }, { id: 'same', label: 'Two' }] } },
    { bindings: { actions: [{ id: 'do', label: 'Do', extra: true }] } },
    { bindings: { workflow: [] } },
  ])('rejects malformed direct binding declarations: %j', ({ bindings }) => {
    const result = parseCodeAppManifest(JSON.stringify({ routes: [{ path: '/', label: 'Home' }], bindings }));
    expect(result.error).not.toBeNull();
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('accepts normalized binding payload field schemas', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      bindings: {
        events: [{ id: 'game.move', label: 'Move played', payload: [
          { name: 'from', type: 'string', required: true },
          { name: 'ply', type: 'number' },
        ] }],
        actions: [{ id: 'game.move.apply', label: 'Apply move', payload: [
          { name: 'origin', type: 'string', required: true },
        ] }],
      },
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.bindings).toEqual({
      events: [{ id: 'game.move', label: 'Move played', payload: [
        { name: 'from', type: 'string', required: true },
        { name: 'ply', type: 'number' },
      ] }],
      actions: [{ id: 'game.move.apply', label: 'Apply move', payload: [
        { name: 'origin', type: 'string', required: true },
      ] }],
    });
  });

  it.each([
    { bindings: { events: [{ id: 'e', label: 'E', payload: 'wrong' }] } },
    { bindings: { events: [{ id: 'e', label: 'E', payload: [{ name: 'Bad-Name', type: 'string' }] }] } },
    { bindings: { events: [{ id: 'e', label: 'E', payload: [{ name: 'ok', type: 'unknown-type' }] }] } },
    { bindings: { events: [{ id: 'e', label: 'E', payload: [{ name: 'ok', type: 'string' }, { name: 'ok', type: 'number' }] }] } },
  ])('rejects malformed binding payload field schemas: %j', ({ bindings }) => {
    const result = parseCodeAppManifest(JSON.stringify({ routes: [{ path: '/', label: 'Home' }], bindings }));
    expect(result.error).not.toBeNull();
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('accepts explicit channel routes and validates their field maps', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Game' }],
      bindings: {
        events: [{ id: 'game.move', label: 'Move', payload: [{ name: 'from', type: 'string', required: true }] }],
        actions: [{ id: 'game.move.apply', label: 'Apply', payload: [{ name: 'origin', type: 'string', required: true }] }],
      },
      channels: { shares: [{
        id: 'match', label: 'Match', events: ['game.move'], actions: ['game.move.apply'],
        routes: [{ eventId: 'game.move', actionId: 'game.move.apply', fieldMap: { origin: 'from' } }],
        maxParticipants: 8,
      }] },
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.channels?.shares?.[0].routes).toEqual([
      { eventId: 'game.move', actionId: 'game.move.apply', fieldMap: { origin: 'from' } },
    ]);
  });

  it.each([
    { routes: undefined, expected: /requires at least one route/i },
    { routes: [{ eventId: 'missing', actionId: 'game.move.apply' }], expected: /undeclared event/i },
    { routes: [{ eventId: 'game.move', actionId: 'missing' }], expected: /undeclared action/i },
    { routes: [{ eventId: 'game.move', actionId: 'game.move.apply', fieldMap: { origin: 'missing' } }], expected: /fieldMap is invalid/i },
  ])('rejects unsafe channel routing: $expected', ({ routes, expected }) => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Game' }],
      bindings: {
        events: [{ id: 'game.move', label: 'Move', payload: [{ name: 'from', type: 'string', required: true }] }],
        actions: [{ id: 'game.move.apply', label: 'Apply', payload: [{ name: 'origin', type: 'string', required: true }] }],
      },
      channels: { shares: [{
        id: 'match', label: 'Match', events: ['game.move'], actions: ['game.move.apply'], routes,
      }] },
    }));
    expect(result.error).toMatch(expected);
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('accepts normalized role declarations', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      roles: [
        { id: 'player', label: ' Player ', extends: 'editor', description: ' Can move ' },
        { id: 'spectator', label: 'Spectator', extends: 'viewer' },
      ],
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.roles).toEqual([
      { id: 'player', label: 'Player', extends: 'editor', description: 'Can move' },
      { id: 'spectator', label: 'Spectator', extends: 'viewer' },
    ]);
  });

  it.each([
    { roles: 'wrong' },
    { roles: [{ id: 'owner', label: 'Owner', extends: 'owner' }] },
    { roles: [{ id: 'Player', label: 'Player', extends: 'editor' }] },
    { roles: [{ id: 'player', label: 'Player' }] },
    { roles: [{ id: 'player', label: 'Player', extends: 'admin' }] },
    { roles: [{ id: 'player', label: 'Player', extends: 'editor', extra: true }] },
    { roles: [{ id: 'a', label: 'A', extends: 'editor' }, { id: 'a', label: 'B', extends: 'viewer' }] },
    { roles: Array.from({ length: 17 }, (_, index) => ({ id: `role${index}`, label: `Role ${index}`, extends: 'viewer' })) },
  ])('rejects malformed role declarations: %j', ({ roles }) => {
    const result = parseCodeAppManifest(JSON.stringify({ routes: [{ path: '/', label: 'Home' }], roles }));
    expect(result.error).not.toBeNull();
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('builds stable host URLs for normalized routes', () => {
    expect(normalizeCodeAppRoutePath('tasks/')).toBe('/tasks');
    expect(codeAppRouteUrl('dapp-1', '/')).toBe('/dapp/dapp-1/app');
    expect(codeAppRouteUrl('dapp-1', '/tasks')).toBe('/dapp/dapp-1/app/tasks');
    expect(codeAppFullscreenRouteUrl('dapp-1', '/')).toBe('/dapp/dapp-1/full');
    expect(codeAppFullscreenRouteUrl('dapp-1', '/tasks')).toBe('/dapp/dapp-1/full/tasks');
  });

  it('accepts a hidden route flag — presentation only, still a normal route', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [
        { path: '/', label: 'Overview' },
        { path: '/secret', label: 'Secret Ops', hidden: true },
      ],
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.routes).toEqual([
      { path: '/', label: 'Overview' },
      { path: '/secret', label: 'Secret Ops', hidden: true },
    ]);
  });

  it('rejects a non-boolean hidden flag', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Overview', hidden: 'yes' }],
    }));
    expect(result.error).toMatch(/hidden/i);
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('accepts a manifest-requested fullscreen display default', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      display: { chrome: 'fullscreen' },
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.display).toEqual({ chrome: 'fullscreen' });
  });

  it('accepts display.frameButton to hide the fullscreen return button', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      display: { chrome: 'fullscreen', frameButton: false },
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.display).toEqual({ chrome: 'fullscreen', frameButton: false });
  });

  it.each([
    { display: 'wrong' },
    { display: { chrome: 'minimal' } },
    { display: { chrome: 'fullscreen', extra: true } },
    { display: { frameButton: 'no' } },
  ])('rejects malformed display declarations: %j', ({ display }) => {
    const result = parseCodeAppManifest(JSON.stringify({ routes: [{ path: '/', label: 'Home' }], display }));
    expect(result.error).not.toBeNull();
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });

  it('parses the storage record format and rejects malformed declarations', () => {
    const compact = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      storage: { recordFormat: 'compact' },
    }));
    expect(compact.error).toBeNull();
    expect(compact.manifest.storage).toEqual({ recordFormat: 'compact' });

    for (const storage of ['compact', { recordFormat: 'zip' }, { recordFormat: 'compact', extra: 1 }]) {
      const result = parseCodeAppManifest(JSON.stringify({ routes: [{ path: '/', label: 'Home' }], storage }));
      expect(result.error).not.toBeNull();
    }
  });

  it('parses an entities section and passes advisory field extras through', () => {
    const result = parseCodeAppManifest(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      entities: [{
        id: 'recipes', name: 'Recipes', icon: '🍳', color: '#c26a1b',
        fields: [
          { id: 'title', name: 'Title', type: 'text', required: true },
          { id: 'rating', name: 'Rating', type: 'number', defaultValue: 0 },
        ],
      }],
    }));
    expect(result.error).toBeNull();
    expect(result.manifest.entities).toEqual([{
      id: 'recipes', name: 'Recipes', icon: '🍳', color: '#c26a1b',
      fields: [
        { id: 'title', name: 'Title', type: 'text', required: true },
        { id: 'rating', name: 'Rating', type: 'number', defaultValue: 0 },
      ],
    }]);
  });

  it.each([
    { label: 'empty array', entities: [] },
    { label: 'entity without id', entities: [{ name: 'X', fields: [{ id: 'a', name: 'A', type: 'text' }] }] },
    { label: 'duplicate entity ids', entities: [
      { id: 'x', name: 'X', fields: [{ id: 'a', name: 'A', type: 'text' }] },
      { id: 'x', name: 'X2', fields: [{ id: 'a', name: 'A', type: 'text' }] },
    ] },
    { label: 'empty fields', entities: [{ id: 'x', name: 'X', fields: [] }] },
    { label: 'unsupported field type', entities: [{ id: 'x', name: 'X', fields: [{ id: 'a', name: 'A', type: 'blob' }] }] },
    { label: 'duplicate field ids', entities: [{ id: 'x', name: 'X', fields: [
      { id: 'a', name: 'A', type: 'text' }, { id: 'a', name: 'B', type: 'text' },
    ] }] },
  ])('rejects malformed entities: $label', ({ entities }) => {
    const result = parseCodeAppManifest(JSON.stringify({ routes: [{ path: '/', label: 'Home' }], entities }));
    expect(result.error).not.toBeNull();
    expect(result.manifest).toEqual(LEGACY_CODE_APP_MANIFEST);
  });
});
