import { describe, expect, it } from 'vitest';
import type { CodeAppBindingField } from '../types.ts';
import {
  isFieldTypeCompatible,
  projectPayload,
  suggestFieldMap,
  validateFieldMap,
  validatePayload,
  validatePayloadValue,
} from '../services/bindingPayload.ts';

const stringField: CodeAppBindingField = { name: 'title', type: 'string', required: true };
const numberField: CodeAppBindingField = { name: 'count', type: 'number' };
const jsonField: CodeAppBindingField = { name: 'meta', type: 'json' };

describe('validatePayloadValue', () => {
  it('checks a value against its declared type', () => {
    expect(validatePayloadValue(stringField, 'hello')).toEqual({ ok: true, value: 'hello' });
    expect(validatePayloadValue(stringField, 5).ok).toBe(false);
    expect(validatePayloadValue(numberField, 5).ok).toBe(true);
    expect(validatePayloadValue(numberField, Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validatePayloadValue({ name: 'flags', type: 'boolean[]' }, [true, false]).ok).toBe(true);
    expect(validatePayloadValue({ name: 'flags', type: 'boolean[]' }, [true, 'x']).ok).toBe(false);
  });

  it('accepts any JSON-serializable value for a json field', () => {
    expect(validatePayloadValue(jsonField, { nested: [1, 'a', null, true] }).ok).toBe(true);
    expect(validatePayloadValue(jsonField, 'plain string').ok).toBe(true);
    expect(validatePayloadValue(jsonField, undefined).ok).toBe(false);
  });
});

describe('validatePayload', () => {
  const schema: CodeAppBindingField[] = [stringField, numberField];

  it('fails closed on a missing required field with a readable message', () => {
    const result = validatePayload(schema, { count: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/title/i);
  });

  it('fails closed on a type violation', () => {
    const result = validatePayload(schema, { title: 'ok', count: 'not a number' });
    expect(result.ok).toBe(false);
  });

  it('fails closed when the payload exceeds the size ceiling', () => {
    const result = validatePayload(undefined, { blob: 'x'.repeat(70_000) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exceeds/i);
  });

  it('drops optional fields that are absent and keeps required + present optional fields', () => {
    const result = validatePayload(schema, { title: 'ok' });
    expect(result).toEqual({ ok: true, value: { title: 'ok' } });
  });

  it('passes any JSON-serializable value through unchanged for an undeclared (opaque) schema', () => {
    expect(validatePayload(undefined, { anything: [1, 2, 3] })).toEqual({ ok: true, value: { anything: [1, 2, 3] } });
    expect(validatePayload(undefined, 'a plain string')).toEqual({ ok: true, value: 'a plain string' });
  });

  it('rejects a non-object payload against a declared schema', () => {
    expect(validatePayload(schema, 'not an object').ok).toBe(false);
  });
});

describe('isFieldTypeCompatible', () => {
  it('is exact-type-equal, plus any type widening into json', () => {
    expect(isFieldTypeCompatible('string', 'string')).toBe(true);
    expect(isFieldTypeCompatible('string', 'number')).toBe(false);
    expect(isFieldTypeCompatible('string', 'json')).toBe(true);
    expect(isFieldTypeCompatible('number[]', 'json')).toBe(true);
  });

  it('rejects json narrowing into a concrete type', () => {
    expect(isFieldTypeCompatible('json', 'string')).toBe(false);
    expect(isFieldTypeCompatible('json', 'json')).toBe(true);
  });
});

describe('suggestFieldMap', () => {
  it('matches by exact name first', () => {
    const source: CodeAppBindingField[] = [{ name: 'title', type: 'string' }, { name: 'count', type: 'number' }];
    const destination: CodeAppBindingField[] = [{ name: 'title', type: 'string' }];
    expect(suggestFieldMap(source, destination)).toEqual({ title: 'title' });
  });

  it('falls back to a unique compatible type when names differ', () => {
    const source: CodeAppBindingField[] = [{ name: 'from', type: 'string' }];
    const destination: CodeAppBindingField[] = [{ name: 'origin', type: 'string' }];
    expect(suggestFieldMap(source, destination)).toEqual({ origin: 'from' });
  });

  it('leaves ambiguous fields unmapped when two source fields share a compatible type', () => {
    const source: CodeAppBindingField[] = [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }];
    const destination: CodeAppBindingField[] = [{ name: 'target', type: 'string' }];
    expect(suggestFieldMap(source, destination)).toEqual({});
  });

  it('returns an empty map when either side has no declared schema', () => {
    expect(suggestFieldMap(undefined, [stringField])).toEqual({});
    expect(suggestFieldMap([stringField], undefined)).toEqual({});
  });
});

describe('validateFieldMap', () => {
  it('fails when a required destination field is unmapped', () => {
    const result = validateFieldMap([numberField], [stringField], {});
    expect(result.ok).toBe(false);
  });

  it('fails when a mapped source name does not exist', () => {
    const result = validateFieldMap([numberField], [stringField], { title: 'missing' });
    expect(result.ok).toBe(false);
  });

  it('fails when a mapped pair is type-incompatible', () => {
    const result = validateFieldMap([numberField], [stringField], { title: 'count' });
    expect(result.ok).toBe(false);
  });

  it('passes a valid mapping', () => {
    const result = validateFieldMap([{ name: 'from', type: 'string' }], [stringField], { title: 'from' });
    expect(result.ok).toBe(true);
  });

  it('accepts anything for an undeclared (opaque) destination', () => {
    expect(validateFieldMap([stringField], undefined, {})).toEqual({ ok: true });
  });

  it('rejects an undeclared source only when a destination field is required', () => {
    expect(validateFieldMap(undefined, [{ name: 'optional', type: 'string' }], {})).toEqual({ ok: true });
    expect(validateFieldMap(undefined, [stringField], {}).ok).toBe(false);
  });
});

describe('projectPayload', () => {
  it('renames fields per the map and drops unmapped source fields', () => {
    const projected = projectPayload({ destinationName: 'sourceName' }, { sourceName: 'value', extra: 'dropped' });
    expect(projected).toEqual({ destinationName: 'value' });
  });

  it('omits a mapped destination field whose source field is absent from the payload', () => {
    const projected = projectPayload({ destinationName: 'missing' }, { other: 'value' });
    expect(projected).toEqual({});
  });
});
