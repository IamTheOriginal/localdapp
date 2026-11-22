/**
 * Minimal 5-field cron expression support for the automation engine.
 * Fields: minute hour day-of-month month day-of-week (0=Sunday, 7=Sunday).
 * Supports: star, step values, ranges, lists and combinations like "a-b/n".
 * Pure math — no timers, no timezone magic (local time of the host).
 */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 normalised to 0)
];

function parseField(raw: string, index: number): Set<number> {
  const [min, max] = FIELD_BOUNDS[index];
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`automations cron: Empty field part in "${raw}"`);
    const [rangePart, stepPart] = trimmed.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`automations cron: Invalid step "${stepPart}"`);
    let start = min;
    let end = max;
    if (rangePart !== '*' && rangePart !== '') {
      const bounds = rangePart.split('-');
      if (bounds.length > 2) throw new Error(`automations cron: Malformed range "${rangePart}"`);
      start = Number(bounds[0]);
      end = bounds.length === 2 ? Number(bounds[1]) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`automations cron: Non-numeric bound in "${rangePart}"`);
      if (start < min || end > max || start > end) throw new Error(`automations cron: Range ${start}-${end} outside ${min}-${max}`);
    }
    for (let value = start; value <= end; value += step) values.add(index === 4 ? value % 7 : value);
  }
  if (values.size === 0) throw new Error(`automations cron: Field "${raw}" matched no values`);
  return values;
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`automations cron: Expected 5 fields, got ${fields.length} in "${expression}"`);
  return {
    minutes: parseField(fields[0], 0),
    hours: parseField(fields[1], 1),
    daysOfMonth: parseField(fields[2], 2),
    months: parseField(fields[3], 3),
    daysOfWeek: parseField(fields[4], 4),
  };
}

function matchesDay(fields: CronFields, date: Date): boolean {
  const domMatch = fields.daysOfMonth.has(date.getDate());
  const dowMatch = fields.daysOfWeek.has(date.getDay());
  // Standard vixie-cron semantics: if both day fields are restricted, either may match.
  const domRestricted = fields.daysOfMonth.size !== 31;
  const dowRestricted = fields.daysOfWeek.size !== 7;
  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Next fire time strictly after `after`, or null beyond the 5-year search horizon. */
export function nextCronRun(expression: string, after: Date): Date | null {
  const fields = parseCron(expression);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const horizon = after.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= horizon) {
    if (!fields.months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(fields, candidate)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hours.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minutes.has(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1);
      continue;
    }
    return new Date(candidate.getTime());
  }
  return null;
}

/** Whether `date` is a fire time for this schedule (exact minute match). */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = parseCron(expression);
  return fields.minutes.has(date.getMinutes())
    && fields.hours.has(date.getHours())
    && fields.months.has(date.getMonth() + 1)
    && matchesDay(fields, date);
}
