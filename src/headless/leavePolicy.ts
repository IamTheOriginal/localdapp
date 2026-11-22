import type * as Y from 'yjs';
import { foundingOwnerOf } from '../services/store/protocolCore.ts';

/**
 * How the keeper may drop a dapp:
 * - `founder`: it created the dapp. The founding owner cannot leave — dropping
 *   the local copy leaves it a member everywhere else while it holds nothing,
 *   so this needs an explicit "drop it anyway".
 * - `member`: it signs a departure first, so the other members stop listing it.
 * - `none`: it never was (or no longer is) a member — nothing to announce.
 */
export type KeeperLeaveKind = 'founder' | 'member' | 'none';

export function keeperLeaveKind(doc: Y.Doc, selfKey: string): KeeperLeaveKind {
  if (foundingOwnerOf(doc) === selfKey) return 'founder';
  return doc.getMap('members').has(selfKey) ? 'member' : 'none';
}
