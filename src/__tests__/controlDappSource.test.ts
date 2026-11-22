import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodeAppManifest } from '../services/codeAppManifest.ts';
import { validateCodeAppFiles } from '../services/store/source.ts';

// The Keeper Control app is a headless-only content bundle (installed by the
// keeper as the source of a dapp it creates), not a catalog starter — so it
// lives under src/headless/controlDapp/ rather than public/starters/. Load
// the shipped files straight from disk so content defects fail here.
const CONTROL_DAPP_DIR = join(import.meta.dirname, '..', 'headless', 'controlDapp');

function file(name: string): string {
  return readFileSync(join(CONTROL_DAPP_DIR, name), 'utf8');
}

const source = {
  'index.html': file('index.html'),
  'styles.css': file('styles.css'),
  'app.js': file('app.js'),
  'manifest.yaml': file('manifest.yaml'),
};

describe('Keeper Control control dapp source', () => {
  it('has a manifest that parses with no bindings/permissions and the documented entities', () => {
    const { manifest, error } = parseCodeAppManifest(source['manifest.yaml']);
    expect(error).toBeNull();
    expect(manifest.name).toBe('Keeper Control');
    expect(manifest.icon).toBe('🛰️');
    expect(manifest.color).toBe('#0ea5e9');
    expect(manifest.routes).toEqual([{ path: '/', label: 'Keeper', icon: 'dashboard' }]);
    expect(manifest.bindings).toBeUndefined();
    expect(manifest.permissions).toBeUndefined();

    const entityIds = manifest.entities?.map((entity) => entity.id);
    expect(entityIds).toEqual(['commands', 'keeper']);

    const commands = manifest.entities?.find((entity) => entity.id === 'commands');
    expect(commands?.fields).toEqual([
      { id: 'type', name: 'Type', type: 'text', required: true },
      { id: 'status', name: 'Status', type: 'text', required: true },
      { id: 'error', name: 'Error', type: 'text' },
    ]);

    const keeper = manifest.entities?.find((entity) => entity.id === 'keeper');
    expect(keeper?.fields).toEqual([{ id: 'displayName', name: 'Display name', type: 'text' }]);
  });

  it('passes validateCodeAppFiles as a complete, self-contained file map', () => {
    expect(() => validateCodeAppFiles(source)).not.toThrow();
    expect(Object.keys(validateCodeAppFiles(source)).sort()).toEqual(
      ['app.js', 'index.html', 'manifest.yaml', 'styles.css'],
    );
  });

  it('links styles.css and app.js from index.html as local classic-script/stylesheet references', () => {
    expect(source['index.html']).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="styles\.css"/);
    expect(source['index.html']).toMatch(/<script[^>]+src="app\.js"/);
    // Only one script tag: the app is required to stay a single classic script.
    expect(source['index.html'].match(/<script\b/g)?.length).toBe(1);
  });

  it('never resolves network permissions and stays script-module-free', () => {
    expect(source['index.html']).not.toMatch(/type=["']module["']/);
    expect(source['manifest.yaml']).not.toMatch(/permissions:/);
  });

  it('wires up the AI commands (model selection, create/update/revert dapp)', () => {
    expect(source['index.html']).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="styles\.css"/);
    expect(source['index.html']).toMatch(/<script[^>]+src="app\.js"/);
    expect(source['app.js']).toMatch(/create-dapp/);
    expect(source['app.js']).toMatch(/update-dapp/);
    expect(source['app.js']).toMatch(/revert-dapp/);
    expect(source['app.js']).toMatch(/set-model/);
  });
});
