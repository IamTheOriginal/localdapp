import { describe, expect, it } from 'vitest';
import { must } from './helpers/must.ts';
import * as Y from 'yjs';
import type { AutomationRule } from '../types.ts';
import { cronMatches, nextCronRun, parseCron } from '../automations/cron.ts';
import { dueCronRules, resolveTemplate, runAutomationRule } from '../automations/engine.ts';
import type { AutomationHost } from '../automations/engine.ts';
import {
  deleteAutomationRule, getAutomationRule, listAutomationRules, putAutomationRule, recordAutomationRun,
} from '../services/store/automations.ts';

function date(iso: string): Date {
  return new Date(iso);
}

describe('cron expressions', () => {
  it('parses fields, ranges, steps and lists', () => {
    const fields = parseCron('*/15 0 1,15 * 1-5');
    expect(fields.minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(fields.hours).toEqual(new Set([0]));
    expect(fields.daysOfMonth).toEqual(new Set([1, 15]));
    expect(fields.months).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(fields.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('normalises sunday as both 0 and 7', () => {
    expect(parseCron('0 12 * * 7').daysOfWeek.has(0)).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow();
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('a b c d e')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow();
  });

  it('computes the exact next run across hour, day and month boundaries', () => {
    expect(must(nextCronRun('30 9 * * *', date('2026-08-21T14:00:00'))).getTime()).toBe(date('2026-08-22T09:30:00').getTime());
    expect(must(nextCronRun('0 0 1 * *', date('2026-08-21T14:00:00'))).getTime()).toBe(date('2026-09-01T00:00:00').getTime());
    expect(must(nextCronRun('59 23 31 12 *', date('2026-08-21T14:00:00'))).getTime()).toBe(date('2026-12-31T23:59:00').getTime());
    expect(must(nextCronRun('* * * * *', date('2026-08-21T14:07:32'))).toISOString()).toBe(date('2026-08-21T14:08:00').toISOString());
  });

  it('returns strictly-after results and matches fire minutes exactly', () => {
    const at = date('2026-08-21T09:30:00');
    expect(must(nextCronRun('30 9 * * *', at)).getTime()).toBe(date('2026-08-22T09:30:00').getTime());
    expect(cronMatches('30 9 * * *', at)).toBe(true);
    expect(cronMatches('30 9 * * *', date('2026-08-21T09:31:00'))).toBe(false);
  });
});

describe('template resolution', () => {
  const context = { trigger: { kind: 'cron' as const, firedAt: '2026-08-21T07:05:00.000Z' } };

  it('resolves trigger paths, now helpers and object leaves', () => {
    expect(resolveTemplate('{{trigger.kind}}', context)).toBe('cron');
    expect(resolveTemplate('{{now.date}}', context)).toBe('2026-08-21');
    expect(resolveTemplate('{{now.time}}', context)).toBe('07:05');
    const resolved = resolveTemplate({
      note: 'Fired by {{trigger.kind}} at {{trigger.firedAt}}',
      when: '{{now.iso}}',
      count: 3,
      flag: true,
    }, context);
    expect(resolved).toEqual({
      note: 'Fired by cron at 2026-08-21T07:05:00.000Z',
      when: '2026-08-21T07:05:00.000Z',
      count: 3,
      flag: true,
    });
  });

  it('leaves unknown references untouched instead of crashing', () => {
    expect(resolveTemplate('{{trigger.nope}}', context)).toBe('{{trigger.nope}}');
    expect(resolveTemplate({ x: ['{{now.nope}}'] }, context)).toEqual({ x: ['{{now.nope}}'] });
  });
});

function hostSpy() {
  const calls: Record<string, Array<unknown[]>> = {};
  const push = (op: string) => (...args: unknown[]) => { (calls[op] ??= []).push(args); return Promise.resolve(); };
  const host: AutomationHost = {
    createRecord: push('create'),
    updateRecord: push('update'),
    now: () => new Date('2026-08-21T07:05:00.000Z'),
  };
  return { host, calls };
}

function ruleWith(steps: AutomationRule['steps']): AutomationRule {
  return {
    schemaVersion: 1,
    id: 'rule-1',
    name: 'Test rule',
    enabled: true,
    trigger: { kind: 'cron', schedule: '* * * * *' },
    steps,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

const context = { trigger: { kind: 'cron' as const, firedAt: '2026-08-21T07:05:00.000Z' } };

describe('automation engine', () => {
  it('executes create and update steps in order with resolved payloads', async () => {
    const { host, calls } = hostSpy();
    const report = await runAutomationRule(ruleWith([
      { kind: 'create-record', dappId: 'habits', collection: 'log', data: { habitId: 'water', day: '{{now.date}}' } },
      { kind: 'update-record', dappId: 'habits', collection: 'log', recordIdTemplate: 'row-{{now.date}}', data: { ok: true } },
    ]), context, host);

    expect(report.ok).toBe(true);
    expect(calls['create'][0]).toEqual(['habits', 'log', { habitId: 'water', day: '2026-08-21' }]);
    expect(calls['update'][0]).toEqual(['habits', 'log', 'row-2026-08-21', { ok: true }]);
  });

  it('isolates failing steps and reports per-step errors without aborting siblings', async () => {
    const { host, calls } = hostSpy();
    const report = await runAutomationRule(ruleWith([
      { kind: 'create-record', dappId: '', collection: 'x', data: {} },
      { kind: 'create-record', dappId: 'habits', collection: 'log', data: { ok: true } },
      { kind: 'update-record', dappId: 'habits', collection: 'log', recordIdTemplate: '   ', data: {} },
    ]), context, host);

    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(3);
    expect(report.results[0].ok).toBe(false);
    expect(report.results[1].ok).toBe(true);
    expect(report.results[2].ok).toBe(false);
    expect(calls['create']).toHaveLength(1);
  });
});

describe('trigger selectors', () => {
  it('marks cron rules due only inside their fire minute', () => {
    const cronRules: AutomationRule[] = [
      { ...ruleWith([]), id: 'daily', trigger: { kind: 'cron', schedule: '0 9 * * *' } },
      { ...ruleWith([]), id: 'disabled', enabled: false, trigger: { kind: 'cron', schedule: '0 9 * * *' } },
    ];
    expect(dueCronRules(cronRules, new Date('2026-08-21T09:00:00')).map((rule) => rule.id)).toEqual(['daily']);
    expect(dueCronRules(cronRules, new Date('2026-08-21T09:01:00'))).toEqual([]);
    expect(dueCronRules([{ ...ruleWith([]), id: 'bad', trigger: { kind: 'cron', schedule: 'nope' } }], new Date('2026-08-21T09:00:00'))).toEqual([]);
  });
});

describe('rules store', () => {
  it('round-trips rules through a real Yjs doc and records runs', () => {
    const doc = new Y.Doc();
    const stored = putAutomationRule({
      id: 'morning-log',
      name: 'Morning log',
      enabled: true,
      trigger: { kind: 'cron', schedule: '0 7 * * *' },
      steps: [{ kind: 'create-record', dappId: 'habits', collection: 'log', data: { day: '{{now.date}}' } }],
    }, doc);
    expect(stored.createdAt).toBeTruthy();
    expect(getAutomationRule('morning-log', doc)?.name).toBe('Morning log');
    expect(listAutomationRules(doc)).toHaveLength(1);

    recordAutomationRun('morning-log', { at: '2026-08-21T07:00:00.000Z', error: 'boom' }, doc);
    expect(getAutomationRule('morning-log', doc)?.lastError).toBe('boom');
    recordAutomationRun('morning-log', { at: '2026-08-22T07:00:00.000Z' }, doc);
    expect(getAutomationRule('morning-log', doc)?.lastError).toBeUndefined();
    expect(getAutomationRule('morning-log', doc)?.lastRunAt).toBe('2026-08-22T07:00:00.000Z');

    putAutomationRule({
      id: 'morning-log',
      name: 'Renamed',
      enabled: false,
      trigger: { kind: 'cron', schedule: '30 7 * * *' },
      steps: [],
    }, doc);
    const updated = must(getAutomationRule('morning-log', doc));
    expect(updated.name).toBe('Renamed');
    expect(updated.updatedAt >= stored.createdAt).toBe(true);

    expect(deleteAutomationRule('morning-log', doc)).toBe(true);
    expect(deleteAutomationRule('morning-log', doc)).toBe(false);
    expect(listAutomationRules(doc)).toHaveLength(0);
  });

  it('rejects malformed rules at write time', () => {
    const doc = new Y.Doc();
    expect(() => putAutomationRule({
      id: ' ', name: 'x', enabled: true, trigger: { kind: 'cron', schedule: '* * * * *' }, steps: [],
    }, doc)).toThrow();
    expect(() => putAutomationRule({
      id: 'ok-id', name: 'x', enabled: true, trigger: { kind: 'cron', schedule: '* * * * *' },
      steps: [{ kind: 'create-record', dappId: ' ', collection: 'x', data: {} }],
    }, doc)).toThrow();
  });
});
