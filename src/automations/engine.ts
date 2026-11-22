import type {
  AutomationContext, AutomationRule, AutomationRunReport, AutomationStep, CanonicalJson,
} from '../types.ts';
import { cronMatches } from './cron.ts';

/**
 * Executes automation rules against a thin host interface. Pure orchestration —
 * the headless keeper is the only host today; only the host differs. All step
 * payloads support `{{path}}` templates resolved against the trigger context
 * (`trigger.*`) and the fire time (`now.*`).
 */

export interface AutomationHost {
  createRecord(dappId: string, collection: string, data: Record<string, CanonicalJson>): Promise<void>;
  updateRecord(dappId: string, collection: string, recordId: string, data: Record<string, CanonicalJson>): Promise<void>;
  now(): Date;
}

/** Resolves `{{a.b.c}}` references in every string leaf of a template payload. */
export function resolveTemplate(template: CanonicalJson, context: AutomationContext): CanonicalJson {
  const now = new Date(context.trigger.firedAt);
  const root: Record<string, unknown> = {
    trigger: context.trigger,
    now: {
      iso: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 16),
    },
  };
  const lookup = (path: string): string | undefined => {
    let current: unknown = root;
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    if (current === undefined || current === null) return undefined;
    if (typeof current === 'object') return JSON.stringify(current);
    if (typeof current === 'string') return current;
    if (typeof current === 'number' || typeof current === 'boolean' || typeof current === 'bigint') return String(current);
    // Context values are CanonicalJson — symbols/functions cannot occur.
    return undefined;
  };

  const replaceInString = (value: string): string => value.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, path: string) => lookup(path) ?? whole);

  if (typeof template === 'string') return replaceInString(template);
  if (Array.isArray(template)) return template.map((entry) => resolveTemplate(entry, context));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolveTemplate(value, context)]));
  }
  return template;
}

function asRecord(data: CanonicalJson): Record<string, CanonicalJson> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('automations engine: Step data must be a JSON object');
  return data;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value || !value.trim()) throw new Error(`automations engine: Step ${label} is empty`);
  return value;
}

async function executeStep(step: AutomationStep, context: AutomationContext, host: AutomationHost): Promise<void> {
  switch (step.kind) {
    case 'create-record': {
      requireNonEmpty(step.dappId, 'dappId');
      requireNonEmpty(step.collection, 'collection');
      await host.createRecord(step.dappId, step.collection, asRecord(resolveTemplate(step.data, context)));
      return;
    }
    case 'update-record': {
      requireNonEmpty(step.dappId, 'dappId');
      requireNonEmpty(step.collection, 'collection');
      const recordId = requireNonEmpty(resolveTemplate(step.recordIdTemplate, context) as string, 'resolved record id');
      await host.updateRecord(step.dappId, step.collection, recordId, asRecord(resolveTemplate(step.data, context)));
      return;
    }
    default: {
      const exhaustive: never = step;
      throw new Error(`automations engine: Unknown step kind ${(exhaustive as { kind: string }).kind}`);
    }
  }
}

export async function runAutomationRule(rule: AutomationRule, context: AutomationContext, host: AutomationHost): Promise<AutomationRunReport> {
  const results: AutomationRunReport['results'] = [];
  for (let index = 0; index < rule.steps.length; index += 1) {
    try {
      await executeStep(rule.steps[index], context, host);
      results.push({ stepIndex: index, ok: true });
    } catch (error) {
      results.push({ stepIndex: index, ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return { ruleId: rule.id, ok: results.every((entry) => entry.ok), results };
}

export function dueCronRules(rules: AutomationRule[], minute: Date): AutomationRule[] {
  return rules.filter((rule) => {
    if (!rule.enabled || rule.trigger.kind !== 'cron') return false;
    try {
      return cronMatches(rule.trigger.schedule, minute);
    } catch {
      return false; // Invalid schedules surface via validation at edit time, never crash the tick.
    }
  });
}
