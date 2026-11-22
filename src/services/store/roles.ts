import * as Y from 'yjs';
import { getDappDoc } from './docs.ts';
import { getRunnableCodeAppFile } from './sourceSeal.ts';
import { requireRole, signRecord } from './auth.ts';
import { parseCodeAppManifest } from '../codeAppManifest.ts';
import { getIdentity } from '../identity.ts';
import { yMapFromObject } from './protocolCore.ts';
import type { MemberRole } from '../../types.ts';

interface ResolvedAppRole {
  roleId: string;
  extends: MemberRole;
}

interface AppRoleAssignmentView {
  member: { publicKey: string; name: string; role: MemberRole };
  roleId: string | null;
}

function roleAssignmentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('roleAssignments');
}

/**
 * A role assignment is never deleted, only overwritten with `roleId: null` — this reuses the
 * same owner-signed, timestamp-precedence anti-replay mechanism as every other field on the
 * entry (see auth.ts's member baseline+signed-op scan) without needing a separate tombstone map.
 */
async function setAppRoleAssignment(dappId: string, publicKey: string, roleId: string | null): Promise<void> {
  requireRole(dappId, 'owner');
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity to sign with');

  const doc = getDappDoc(dappId);
  const payload: Record<string, unknown> = {
    publicKey,
    roleId,
    assignedAt: new Date().toISOString(),
    assignedBy: identity.publicKey,
  };
  const signature = await signRecord(payload);
  roleAssignmentsMap(doc).set(publicKey, yMapFromObject({ ...payload, ...signature }));
}

export function assignAppRole(dappId: string, publicKey: string, roleId: string): Promise<void> {
  return setAppRoleAssignment(dappId, publicKey, roleId);
}

export function clearAppRole(dappId: string, publicKey: string): Promise<void> {
  return setAppRoleAssignment(dappId, publicKey, null);
}

/** Resolves a stored assignment against the *current* manifest. Fails closed — a stale or removed role id resolves to null rather than granting a stale ceiling. */
export function getAppRole(dappId: string, publicKey: string): ResolvedAppRole | null {
  const doc = getDappDoc(dappId);
  const entry = roleAssignmentsMap(doc).get(publicKey);
  const roleId = entry?.get('roleId') as string | null | undefined;
  if (!roleId) return null;

  // App roles extend base roles — they must come from the owner-sealed manifest (sourceSeal.ts).
  const manifestResult = parseCodeAppManifest(getRunnableCodeAppFile(dappId, 'manifest.yaml'));
  if (manifestResult.error) return null;
  const declared = manifestResult.manifest.roles?.find((role) => role.id === roleId);
  if (!declared) return null;

  return { roleId, extends: declared.extends };
}

/** Every current dapp member with their assigned app role, if any — the pool `$roles.assign` chooses from. */
export function listAppRoleAssignments(dappId: string): AppRoleAssignmentView[] {
  const doc = getDappDoc(dappId);
  const members = doc.getMap('members');
  const assignments = roleAssignmentsMap(doc);
  const result: AppRoleAssignmentView[] = [];
  members.forEach((rawMember, publicKey) => {
    const memberMap = rawMember as Y.Map<unknown>;
    const assignment = assignments.get(publicKey);
    const rawName = memberMap.get('name');
    result.push({
      member: {
        publicKey,
        name: typeof rawName === 'string' ? rawName : '',
        role: (memberMap.get('role') as MemberRole | undefined) || 'viewer',
      },
      roleId: (assignment?.get('roleId') as string | null | undefined) ?? null,
    });
  });
  return result;
}
