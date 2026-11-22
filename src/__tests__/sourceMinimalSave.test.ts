import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { replaceTextMinimal } from '../services/store/source.ts';

function textDoc(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText('file');
  text.insert(0, content);
  return { doc, text };
}

describe('replaceTextMinimal', () => {
  it('ends at the new content for edits at the start, in the middle, at the end and for a full rewrite', () => {
    const before = '<h1>Title</h1>\n<p>Body text</p>\n';
    for (const after of [
      `<!doctype html>\n${before}`,
      '<h1>Title</h1>\n<p>Longer body text here</p>\n',
      `${before}<footer>x</footer>\n`,
      'completely different',
      '',
      before,
    ]) {
      const { text } = textDoc(before);
      replaceTextMinimal(text, after);
      expect(text.toJSON()).toBe(after);
    }
  });

  it('touches only the part that changed', () => {
    const { doc, text } = textDoc('aaaa MIDDLE zzzz');
    const changes: Array<Record<string, unknown>> = [];
    text.observe((event) => { changes.push(...(event.delta as Array<Record<string, unknown>>)); });
    doc.transact(() => { replaceTextMinimal(text, 'aaaa CORE zzzz'); });
    // "MIDDLE" → "CORE": the shared final E stays as well.
    expect(changes).toEqual([{ retain: 5 }, { delete: 5 }, { insert: 'COR' }]);
  });

  it('does not split an emoji when only its second half differs', () => {
    const { text } = textDoc('ok 😀 done');
    replaceTextMinimal(text, 'ok 😃 done');
    expect(text.toJSON()).toBe('ok 😃 done');
    const { text: tail } = textDoc('😀');
    replaceTextMinimal(tail, '😃');
    expect(tail.toJSON()).toBe('😃');
  });

  it('two devices saving the same file while apart do not end up with both versions in a row', () => {
    const original = 'line one\nline two\nline three\n';
    const left = textDoc(original);
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left.doc));
    const rightText = right.getText('file');

    replaceTextMinimal(left.text, 'line one (edited on the laptop)\nline two\nline three\n');
    replaceTextMinimal(rightText, 'line one\nline two\nline three (edited on the phone)\n');
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left.doc));
    Y.applyUpdate(left.doc, Y.encodeStateAsUpdate(right));

    const merged = left.text.toJSON();
    expect(rightText.toJSON()).toBe(merged);
    expect(merged).toBe('line one (edited on the laptop)\nline two\nline three (edited on the phone)\n');
  });
});
