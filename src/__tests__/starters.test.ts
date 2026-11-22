import { describe, expect, it } from 'vitest';
import { parseCodeAppManifest } from '../services/codeAppManifest.ts';
import { validateStarterDefinition, type CodeAppStarterDefinition } from '../services/store/starters.ts';
import { loadStarterDefinitions, loadStarterFilePathsOnDisk, starterScripts } from './helpers/starterFixtures.ts';

const CODE_APP_STARTERS = loadStarterDefinitions();
import { DEFAULT_CODE_APP_HTML, validateCodeAppFiles } from '../services/store/source.ts';

/** All HTML + JS + CSS of a starter, joined — for content assertions. */
function authoredSource(starter: CodeAppStarterDefinition): string {
  return Object.entries(starter.source)
    .filter(([path]) => /\.(html|js|css)$/.test(path))
    .map(([, content]) => content)
    .join('\n');
}

describe('Code App starter catalog', () => {
  // App Studio's whole point is a runtime-defined schema (entities live in $data,
  // records in lazily created $store collections), so it ships no manifest entities.
  const DYNAMIC_SCHEMA_STARTERS = new Set(['app-studio']);

  it('contains exactly eleven unique, executable, non-boilerplate starters', () => {
    expect(CODE_APP_STARTERS.map((starter) => starter.id)).toEqual([
      'app-studio', 'todo-list', 'shared-expenses', 'diary', 'group-chat', 'weight-tracker', 'habit-tracker',
      'recipe-book', 'meal-planner', 'shopping-list', 'game-scores',
    ]);

    for (const starter of CODE_APP_STARTERS) {
      // The catalog's file list and the files on disk must agree exactly: an
      // unlisted file would silently never ship, a listed-but-missing one 404s.
      expect(loadStarterFilePathsOnDisk(starter.id), starter.id).toEqual([...starter.files].sort());
      expect(starter.source['index.html']).not.toBe(DEFAULT_CODE_APP_HTML);
      expect(starter.source['index.html']).toContain('name="viewport"');
      expect(authoredSource(starter)).toMatch(/min-height:\s*44px/);
      if (!DYNAMIC_SCHEMA_STARTERS.has(starter.id)) {
        expect(parseCodeAppManifest(starter.source['manifest.yaml']).manifest.entities?.length ?? 0).toBeGreaterThan(0);
      }
      expect(() => validateStarterDefinition(starter)).not.toThrow();
      expect(() => validateCodeAppFiles(starter.source)).not.toThrow();
      // Intentional: compiling the shipped first-party source (inline and linked
      // scripts alike) is the assertion under test.
      const scripts = starterScripts(starter);
      expect(scripts.length, starter.id).toBeGreaterThan(0);
      for (const script of scripts) {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        expect(() => new Function(script.code), `${starter.id}/${script.path}`).not.toThrow();
      }
      const parsed = parseCodeAppManifest(starter.source['manifest.yaml']);
      expect(parsed.error, starter.id).toBeNull();
      expect(parsed.manifest.routes.length).toBeGreaterThan(0);
    }
  });

  it('declares the platform features each starter demonstrates', () => {
    const manifests = Object.fromEntries(CODE_APP_STARTERS.map((starter) => [starter.id, parseCodeAppManifest(starter.source['manifest.yaml']).manifest]));
    expect(manifests['todo-list'].bindings?.events?.map((entry) => entry.id)).toContain('task.completed');
    expect(manifests['shared-expenses'].roles).toContainEqual(expect.objectContaining({ id: 'settle-up', extends: 'editor' }));
    expect(manifests['shared-expenses'].channels?.shares?.[0]).toEqual(expect.objectContaining({ id: 'expense-settlement', maxParticipants: 1 }));
    expect(manifests.diary.routes.map((route) => route.path)).toEqual(['/', '/entry', '/full']);
    expect(manifests['recipe-book'].routes.map((route) => route.path)).toEqual(['/', '/recipe']);
    expect(manifests.diary.channels?.shares?.[0]?.events).toEqual(['entry.shared']);
    expect(manifests['group-chat'].roles).toContainEqual(expect.objectContaining({ id: 'spectator', extends: 'viewer' }));
    expect(manifests['group-chat'].channels?.shares?.[0]).toEqual(expect.objectContaining({ id: 'group-chat', maxParticipants: 16 }));
    expect(manifests['game-scores'].routes.map((route) => route.path)).toEqual(['/', '/game']);
    expect(manifests['game-scores'].channels?.shares?.[0]).toEqual(expect.objectContaining({ id: 'game-share', maxParticipants: 8 }));
    expect(manifests['game-scores'].channels?.shares?.[0]?.routes).toEqual([
      { eventId: 'game.update', actionId: 'game.update.receive' },
    ]);
    // Reference i18n implementation: a German dictionary file plus $t/$i18n usage.
    const gameScores = CODE_APP_STARTERS.find((starter) => starter.id === 'game-scores');
    expect(gameScores?.files).toContain('i18n/de.json');
    expect(() => { JSON.parse(gameScores?.source['i18n/de.json'] ?? ''); }).not.toThrow();
    expect(gameScores?.source['index.html']).toContain('$i18n.subscribe');
    expect(gameScores?.source['index.html']).toContain('data-i18n');
  });

  it('uses explicit click actions for sandbox-safe mutation buttons', () => {
    const expectedButtons: Record<string, string> = {
      'todo-list': 'add-task',
      'shared-expenses': 'add-expense',
      diary: 'save-entry',
      'group-chat': 'send-message',
      'weight-tracker': 'add-weight',
      'habit-tracker': 'add-habit',
      'recipe-book': 'new-recipe',
      'meal-planner': 'add-meal',
      'shopping-list': 'add-item',
      'game-scores': 'new-game',
    };
    for (const starter of CODE_APP_STARTERS) {
      const source = authoredSource(starter);
      expect(source).not.toContain('<form');
      expect(source).not.toContain("addEventListener('submit'");
      expect(source).toContain('type="button"');
      const buttonId = expectedButtons[starter.id];
      if (buttonId) {
        expect(source).toContain(`id="${buttonId}"`);
        expect(source).toContain(`getElementById('${buttonId}').addEventListener('click'`);
      } else {
        // Dynamically rendered UIs (App Studio) mutate through one delegated
        // click handler on explicit type="button" controls instead of static ids.
        expect(source).toContain("document.addEventListener('click'");
        expect(source).toContain('data-action');
      }
    }
  });

  it('lets the weight tracker share progress over an isolated channel and chart the trend', () => {
    const weight = CODE_APP_STARTERS.find((starter) => starter.id === 'weight-tracker');
    if (!weight) throw new Error('Weight tracker missing from catalog');

    const weightManifest = parseCodeAppManifest(weight.source['manifest.yaml']).manifest;
    expect(weightManifest.routes.map((route) => route.path)).toEqual(['/', '/add']);
    expect(weightManifest.permissions?.host).toEqual(expect.objectContaining({ contacts: true, sharing: true }));
    expect(weightManifest.channels?.shares?.[0]).toEqual(expect.objectContaining({ id: 'weight-share', maxParticipants: 8 }));
    expect(weightManifest.channels?.shares?.[0]?.routes).toEqual([
      { eventId: 'weight.history', actionId: 'weight.history.receive' },
    ]);
    expect(weightManifest.entities?.map((entity) => entity.id)).toEqual(['weights']);
    expect(weightManifest.entities?.[0].fields.map((entry) => entry.id)).toEqual(['date', 'weight', 'note', 'member', 'memberName']);
    expect(weight.source['index.html']).toContain("sort((a,b)=>String(b.date).localeCompare(String(a.date)))");
    expect(weight.source['index.html']).toContain("$store.create('weights',{date:date.value,weight:Number(value.value)");
    // The trend renders as one SVG chart with buddy series alongside your own.
    expect(weight.source['index.html']).toContain('viewBox="0 0 ');
    expect(weight.source['index.html']).toContain("$events.publish('weight.history'");
    // Shared snapshots carry dates and weights only — notes never leave the device.
    expect(weight.source['index.html']).toContain('.map((point)=>[point.date,point.weight])');
  });

  it('lets the habit tracker share habits over an isolated channel and compare progress', () => {
    const habit = CODE_APP_STARTERS.find((starter) => starter.id === 'habit-tracker');
    if (!habit) throw new Error('Habit tracker missing from catalog');

    const habitManifest = parseCodeAppManifest(habit.source['manifest.yaml']).manifest;
    expect(habitManifest.routes.map((route) => route.path)).toEqual(['/today', '/']);
    expect(habitManifest.permissions?.host).toEqual(expect.objectContaining({ contacts: true, sharing: true }));
    expect(habitManifest.channels?.shares?.[0]).toEqual(expect.objectContaining({ id: 'habit-share', maxParticipants: 8 }));
    expect(habitManifest.channels?.shares?.[0]?.routes).toEqual([
      { eventId: 'habit.upsert', actionId: 'habit.upsert.receive' },
      { eventId: 'habit.progress', actionId: 'habit.progress.receive' },
    ]);
    expect(habitManifest.entities?.map((entity) => entity.id)).toEqual(['habits', 'checkins']);
    expect(habitManifest.entities?.[1].fields.map((entry) => entry.id))
      .toEqual(['habitId', 'sharedKey', 'date', 'value', 'member', 'memberName', 'note']);
    // Weekly frequency targets, per-day heatmap, and milestone badges live in the source.
    expect(habitManifest.entities?.[0].fields.map((entry) => entry.id)).toContain('per');
    expect(habit.source['index.html']).toContain("payload.per === 'week' ? 'week' : 'day'");
    expect(habit.source['index.html']).toContain('function renderHeatmap');
    expect(habit.source['index.html']).toContain('TOTAL_MILESTONES');
    // Progress re-sends are upserts keyed by (sharedKey, member, date) — never duplicates.
    expect(habit.source['index.html']).toContain('row.member === member && row.sharedKey === sharedKey && row.date === date');
    // Buddy series render alongside your own in one SVG chart.
    expect(habit.source['index.html']).toContain("seriesMap.set('', { name: myName(), sums: buckets.map(() => 0) })");
    expect(habit.source['index.html']).toContain('<svg viewBox=');
    // Sharing sends definition plus capped history so late buddies catch up.
    expect(habit.source['index.html']).toContain('.slice(0, 366)');
  });

  it('ships the recipe book fully offline: no network permission, no external origins', () => {
    const recipes = CODE_APP_STARTERS.find((starter) => starter.id === 'recipe-book');
    const manifest = parseCodeAppManifest(recipes?.source['manifest.yaml'] ?? '').manifest;
    const source = recipes?.source['index.html'] ?? '';
    expect(manifest.permissions?.network).toBeUndefined();
    expect(source.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/gi)).toBeNull();
    // Shared recipes dedupe on sourceId and land as ordinary signed writes.
    expect(source).toContain("$actions.handle('recipe.receive'");
    expect(source).toContain("{ field: 'sourceId', op: 'eq', value: sourceId }");
  });

  it('uses isolated event payload protocols and hard photo limits', () => {
    const expenses = CODE_APP_STARTERS.find((starter) => starter.id === 'shared-expenses');
    const diary = CODE_APP_STARTERS.find((starter) => starter.id === 'diary');
    const chat = CODE_APP_STARTERS.find((starter) => starter.id === 'group-chat');
    expect(expenses?.source['index.html']).toContain("$events.publish('expense.shared'");
    expect(expenses?.source['index.html']).not.toContain("$store.query('expenses',{kind:");
    expect(expenses?.source['index.html']).toContain("$store.update('expenses',expenseId,{settled:true");
    expect(expenses?.source['index.html']).toContain("Dapp.context.appRole.id==='settle-up'");
    expect(diary?.source['index.html']).toContain('[hidden]{display:none!important}');
    expect(diary?.source['index.html']).toContain('compressPhoto(file,200000)');
    expect(diary?.source['index.html']).toContain('safePhoto(payload.photoDataUrl,48000)');
    expect(diary?.source['index.html']).not.toContain("src=\"'+latest.photoDataUrl");
    expect(chat?.source['index.html']).toContain('bytes(result)>45000');
    expect(chat?.source['index.html']).toContain("$store.query('messages',{messageId})");
    expect(chat?.source['index.html']).toContain('if(isRelayOwner&&context.instanceId)await publish(received,context.instanceId)');
    expect(chat?.source['index.html']).toContain("typeof context.from==='object'");
    expect(chat?.source['index.html']).toContain("$store.query('chatState',{instanceId,relayOwner:true})");
    expect(chat?.source['index.html']).toContain('relayAuthorName:String(message.authorName)');
    expect(chat?.source['index.html']).not.toContain('identity.publicKey');
  });
});
