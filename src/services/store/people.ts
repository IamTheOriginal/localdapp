import * as Y from 'yjs';
import { getRootDoc } from './docs.ts';
import type { Person } from '../../types.ts';

function peopleMap(doc: Y.Doc = getRootDoc()): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>('people');
}

function toPerson(value: Y.Map<unknown>): Person {
  return {
    id: String(value.get('id')),
    schemaVersion: 1,
    displayName: String(value.get('displayName')),
    notes: value.get('notes') ? String(value.get('notes')) : undefined,
    createdAt: String(value.get('createdAt')),
    updatedAt: String(value.get('updatedAt')),
  };
}

export function listPeople(doc: Y.Doc = getRootDoc()): Person[] {
  return Array.from(peopleMap(doc).values())
    .map(toPerson)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function getPerson(personId: string, doc: Y.Doc = getRootDoc()): Person | null {
  const value = peopleMap(doc).get(personId);
  return value ? toPerson(value) : null;
}

export function createPerson(
  displayName: string,
  options: { notes?: string; id?: string } = {},
  doc: Y.Doc = getRootDoc(),
): Person {
  const normalizedName = displayName.trim();
  if (!normalizedName) throw new Error('people: Display name is required');

  const id = options.id ?? crypto.randomUUID();
  const map = peopleMap(doc);
  if (map.has(id)) throw new Error(`people: Person ${id} already exists`);

  const now = new Date().toISOString();
  const value = new Y.Map<unknown>();
  value.set('id', id);
  value.set('schemaVersion', 1);
  value.set('displayName', normalizedName);
  if (options.notes?.trim()) value.set('notes', options.notes.trim());
  value.set('createdAt', now);
  value.set('updatedAt', now);
  map.set(id, value);
  return toPerson(value);
}

export function updatePerson(
  personId: string,
  updates: { displayName?: string; notes?: string },
  doc: Y.Doc = getRootDoc(),
): Person {
  const value = peopleMap(doc).get(personId);
  if (!value) throw new Error(`people: Unknown person ${personId}`);

  if (updates.displayName !== undefined) {
    const name = updates.displayName.trim();
    if (!name) throw new Error('people: Display name is required');
    value.set('displayName', name);
  }
  if (updates.notes !== undefined) {
    const notes = updates.notes.trim();
    if (notes) value.set('notes', notes);
    else value.delete('notes');
  }
  value.set('updatedAt', new Date().toISOString());
  return toPerson(value);
}

export function deletePerson(personId: string, doc: Y.Doc = getRootDoc()): boolean {
  const map = peopleMap(doc);
  if (!map.has(personId)) return false;
  map.delete(personId);
  return true;
}
