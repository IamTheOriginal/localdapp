import * as Y from 'yjs';
import { getRootDoc } from './docs.ts';
import type { AutomationRule } from '../../types.ts';

/**
 * Durable automation rule definitions, stored in the root doc of the device
 * that runs them (the headless keeper).
 */

function rulesMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('automationRules');
}

function toRule(value: Y.Map<unknown>): AutomationRule {
  const trigger = value.get('trigger') as AutomationRule['trigger'];
  const steps = value.get('steps') as AutomationRule['steps'];
  return {
    schemaVersion: 1,
    id: String(value.get('id')),
    name: String(value.get('name')),
    enabled: Boolean(value.get('enabled')),
    trigger,
    steps: Array.isArray(steps) ? steps : [],
    createdAt: String(value.get('createdAt')),
    updatedAt: String(value.get('updatedAt')),
    ...(value.has('lastRunAt') ? { lastRunAt: String(value.get('lastRunAt')) } : {}),
    ...(value.has('lastError') ? { lastError: String(value.get('lastError')) } : {}),
  };
}

export function listAutomationRules(doc: Y.Doc = getRootDoc()): AutomationRule[] {
  return Array.from(rulesMap(doc).values())
    .map((entry) => toRule(entry as Y.Map<unknown>))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function getAutomationRule(id: string, doc: Y.Doc = getRootDoc()): AutomationRule | null {
  const value = rulesMap(doc).get(id);
  return value ? toRule(value as Y.Map<unknown>) : null;
}

export function putAutomationRule(input: Omit<AutomationRule, 'schemaVersion' | 'createdAt' | 'updatedAt'>, doc: Y.Doc = getRootDoc()): AutomationRule {
  if (!input.id.trim() || !input.name.trim()) throw new Error('automations store: Rule id and name are required');
  for (const step of input.steps) {
    if (!step.dappId.trim()) throw new Error('automations store: Every step needs a target dapp');
  }
  const now = new Date().toISOString();
  let row = rulesMap(doc).get(input.id) as Y.Map<unknown> | undefined;
  const createdAt = row && row.has('createdAt') ? String(row.get('createdAt')) : now;
  doc.transact(() => {
    if (!row) {
      row = new Y.Map<unknown>();
      rulesMap(doc).set(input.id, row);
    }
    row.set('schemaVersion', 1);
    row.set('id', input.id);
    row.set('name', input.name.trim());
    row.set('enabled', input.enabled);
    row.set('trigger', JSON.parse(JSON.stringify(input.trigger)));
    row.set('steps', JSON.parse(JSON.stringify(input.steps)));
    row.set('createdAt', createdAt);
    row.set('updatedAt', now);
  }, 'automations-put-rule');
  const stored = getAutomationRule(input.id, doc);
  if (!stored) throw new Error('automation rule was just written but is not readable');
  return stored;
}

export function deleteAutomationRule(id: string, doc: Y.Doc = getRootDoc()): boolean {
  const map = rulesMap(doc);
  if (!map.has(id)) return false;
  map.delete(id);
  return true;
}

export function recordAutomationRun(id: string, options: { at: string; error?: string }, doc: Y.Doc = getRootDoc()): void {
  const row = rulesMap(doc).get(id) as Y.Map<unknown> | undefined;
  if (!row) return;
  doc.transact(() => {
    row.set('lastRunAt', options.at);
    if (options.error === undefined) row.delete('lastError');
    else row.set('lastError', options.error.slice(0, 512));
  }, 'automations-record-run');
}
