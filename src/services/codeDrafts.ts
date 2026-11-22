/**
 * Unsaved code-editor drafts, kept per tab in sessionStorage. The editor has no
 * way to stop every exit (sidebar links, "View App", the back button, a reload
 * after a deploy), and a confirm on each of them would still lose the text on
 * the one it misses — so the draft simply survives and is offered again when
 * the file is opened next. Per tab on purpose: a draft is work in progress of
 * one editing session, not data.
 */

export interface StoredCodeDraft {
  draft: string;
  /** Content of the file when the draft was started — to notice that it changed meanwhile. */
  base: string;
}

/** Larger drafts are not mirrored (sessionStorage quota); the editor's own size limit is far below. */
const MAX_STORED_DRAFT_CHARS = 1_000_000;

function storageKey(dappId: string, path: string): string {
  return `code-draft:${dappId}:${path}`;
}

export function storeCodeDraft(dappId: string, path: string, value: StoredCodeDraft): void {
  if (value.draft.length > MAX_STORED_DRAFT_CHARS) return;
  try {
    sessionStorage.setItem(storageKey(dappId, path), JSON.stringify(value));
  } catch {
    // storage full or unavailable: the draft lives in memory only, as before
  }
}

export function readCodeDraft(dappId: string, path: string): StoredCodeDraft | null {
  try {
    const raw = sessionStorage.getItem(storageKey(dappId, path));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCodeDraft>;
    return typeof parsed.draft === 'string' && typeof parsed.base === 'string' ? { draft: parsed.draft, base: parsed.base } : null;
  } catch {
    return null;
  }
}

export function clearCodeDraft(dappId: string, path: string): void {
  try {
    sessionStorage.removeItem(storageKey(dappId, path));
  } catch {
    // nothing stored
  }
}
