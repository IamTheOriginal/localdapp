import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { keeperLeaveKind } from '../headless/leavePolicy.ts';

const KEEPER = 'aa'.repeat(32);
const SOMEONE = 'bb'.repeat(32);

function dapp(founder: string, members: string[]): Y.Doc {
  const doc = new Y.Doc();
  const meta = new Y.Map<unknown>();
  meta.set('createdBy', founder);
  doc.getMap('config').set('meta', meta);
  members.forEach((key) => doc.getMap('members').set(key, new Y.Map()));
  return doc;
}

describe('keeperLeaveKind', () => {
  it('flags a dapp the keeper founded — it cannot leave, only drop its copy on purpose', () => {
    expect(keeperLeaveKind(dapp(KEEPER, [KEEPER, SOMEONE]), KEEPER)).toBe('founder');
  });

  it('lets a plain member leave with a signed departure', () => {
    expect(keeperLeaveKind(dapp(SOMEONE, [KEEPER, SOMEONE]), KEEPER)).toBe('member');
  });

  it('has nothing to announce when the keeper is not a member (never synced, or already removed)', () => {
    expect(keeperLeaveKind(dapp(SOMEONE, [SOMEONE]), KEEPER)).toBe('none');
    expect(keeperLeaveKind(new Y.Doc(), KEEPER)).toBe('none');
  });
});
