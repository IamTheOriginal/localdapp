import type { CanonicalJson, CodeAppBindingField, CodeAppBindingFieldType } from '../types.ts';
import { MAX_DIRECT_PAYLOAD_BYTES } from './store/directBindings.ts';

type FieldValidationResult =
  | { ok: true; value: CanonicalJson }
  | { ok: false; error: string };

type PayloadValidationResult =
  | { ok: true; value: Record<string, CanonicalJson> }
  | { ok: false; error: string };

type FieldMapValidationResult = { ok: true } | { ok: false; error: string };

/** Recursively checks JSON-serializability, rejecting cycles, functions, undefined, and non-finite numbers. */
function isCanonicalJson(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((item) => isCanonicalJson(item, seen));
  }
  if (type === 'object') {
    if (seen.has(value as object)) return false;
    seen.add(value as object);
    return Object.values(value as Record<string, unknown>).every((item) => isCanonicalJson(item, seen));
  }
  return false;
}

/** Validates a single field's value against its declared type. Does not check `required` — the caller decides what a missing value means. */
export function validatePayloadValue(field: CodeAppBindingField, value: unknown): FieldValidationResult {
  const label = field.label || field.name;
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') return { ok: false, error: `${label} must be a string.` };
      return { ok: true, value };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `${label} must be a finite number.` };
      return { ok: true, value };
    case 'boolean':
      if (typeof value !== 'boolean') return { ok: false, error: `${label} must be a boolean.` };
      return { ok: true, value };
    case 'string[]':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return { ok: false, error: `${label} must be an array of strings.` };
      }
      return { ok: true, value };
    case 'number[]':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
        return { ok: false, error: `${label} must be an array of finite numbers.` };
      }
      return { ok: true, value };
    case 'boolean[]':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'boolean')) {
        return { ok: false, error: `${label} must be an array of booleans.` };
      }
      return { ok: true, value };
    case 'json':
      if (!isCanonicalJson(value, new Set())) return { ok: false, error: `${label} must be JSON-serializable.` };
      return { ok: true, value: value as CanonicalJson };
    default:
      return { ok: false, error: `${label} has an unknown field type.` };
  }
}

/**
 * Validates a payload against a declaration's field schema. `schema` undefined means the
 * declaration is legacy/opaque — any JSON-serializable value passes through unchanged.
 */
export function validatePayload(schema: CodeAppBindingField[] | undefined, payload: unknown): PayloadValidationResult {
  if (!isCanonicalJson(payload, new Set())) return { ok: false, error: 'Payload must be JSON-serializable.' };
  const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (size > MAX_DIRECT_PAYLOAD_BYTES) return { ok: false, error: `Payload exceeds ${MAX_DIRECT_PAYLOAD_BYTES} bytes.` };

  if (!schema) return { ok: true, value: payload as Record<string, CanonicalJson> };

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'Payload must be a JSON object to match the declared field schema.' };
  }

  const result: Record<string, CanonicalJson> = {};
  for (const field of schema) {
    const raw = (payload as Record<string, unknown>)[field.name];
    if (raw === undefined) {
      if (field.required) return { ok: false, error: `${field.label || field.name} is required.` };
      continue;
    }
    const validated = validatePayloadValue(field, raw);
    if (!validated.ok) return validated;
    result[field.name] = validated.value;
  }
  return { ok: true, value: result };
}

/** Exact-type match, plus any type may widen into `json`. `json` may never narrow into a concrete type. */
export function isFieldTypeCompatible(source: CodeAppBindingFieldType, destination: CodeAppBindingFieldType): boolean {
  if (destination === 'json') return true;
  if (source === 'json') return false;
  return source === destination;
}

/** Proposes a destination-field-name -> source-field-name map. Exact name match first, then unique compatible type; ambiguous fields are left unmapped. */
export function suggestFieldMap(
  source: CodeAppBindingField[] | undefined,
  destination: CodeAppBindingField[] | undefined,
): Record<string, string> {
  if (!source || !destination) return {};
  const map: Record<string, string> = {};
  const used = new Set<string>();
  const sourceByName = new Map(source.map((field) => [field.name, field]));

  for (const dest of destination) {
    const candidate = sourceByName.get(dest.name);
    if (candidate && !used.has(candidate.name) && isFieldTypeCompatible(candidate.type, dest.type)) {
      map[dest.name] = candidate.name;
      used.add(candidate.name);
    }
  }

  for (const dest of destination) {
    if (map[dest.name]) continue;
    const compatible = source.filter((field) => !used.has(field.name) && isFieldTypeCompatible(field.type, dest.type));
    if (compatible.length === 1) {
      map[dest.name] = compatible[0].name;
      used.add(compatible[0].name);
    }
  }

  return map;
}

/**
 * Fails if a required destination field has no mapped source field, a mapped source name does
 * not exist, or a mapped pair is type-incompatible. An undeclared (`undefined`) destination
 * accepts anything. An undeclared source is only safe when every destination field is optional.
 */
export function validateFieldMap(
  source: CodeAppBindingField[] | undefined,
  destination: CodeAppBindingField[] | undefined,
  map: Record<string, string>,
): FieldMapValidationResult {
  if (!destination) return { ok: true };

  if (!source) {
    const requiredField = destination.find((field) => field.required);
    if (requiredField) {
      return {
        ok: false,
        error: `${requiredField.label || requiredField.name} is required, but the source event declares no payload fields.`,
      };
    }
    return { ok: true };
  }

  const sourceByName = new Map(source.map((field) => [field.name, field]));
  for (const dest of destination) {
    const sourceName = map[dest.name];
    if (sourceName === undefined) {
      if (dest.required) return { ok: false, error: `${dest.label || dest.name} is required and has no mapped source field.` };
      continue;
    }
    const sourceField = sourceByName.get(sourceName);
    if (!sourceField) return { ok: false, error: `${dest.label || dest.name} is mapped from an unknown source field "${sourceName}".` };
    if (!isFieldTypeCompatible(sourceField.type, dest.type)) {
      return { ok: false, error: `${dest.label || dest.name} cannot receive ${sourceField.type} from "${sourceName}".` };
    }
  }
  return { ok: true };
}

/** Renames source fields to destination field names per `map`; source fields with no mapped destination are dropped. */
export function projectPayload(map: Record<string, string>, payload: Record<string, CanonicalJson>): Record<string, CanonicalJson> {
  const result: Record<string, CanonicalJson> = {};
  for (const [destinationName, sourceName] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(payload, sourceName)) {
      result[destinationName] = payload[sourceName];
    }
  }
  return result;
}
