import type {
  CodeAppBindingDeclaration,
  CodeAppManifest,
  CodeAppManifestShareRoute,
  PendingShareInvite,
} from '../types.ts';

function isBindingDeclaration(value: unknown): value is CodeAppBindingDeclaration {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { label?: unknown }).label === 'string'
    && ((value as { payload?: unknown }).payload === undefined || Array.isArray((value as { payload?: unknown }).payload));
}

function isShareRoute(value: unknown): value is CodeAppManifestShareRoute {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { eventId?: unknown }).eventId === 'string'
    && typeof (value as { actionId?: unknown }).actionId === 'string'
    && ((value as { fieldMap?: unknown }).fieldMap === undefined
      || (Boolean((value as { fieldMap?: unknown }).fieldMap)
        && typeof (value as { fieldMap?: unknown }).fieldMap === 'object'
        && !Array.isArray((value as { fieldMap?: unknown }).fieldMap)));
}

function payloadSignature(declaration: CodeAppBindingDeclaration): string {
  return JSON.stringify((declaration.payload ?? []).map((field) => [
    field.name,
    field.type,
    field.required === true,
    field.label ?? '',
    field.description ?? '',
  ]));
}

function routeSignature(route: CodeAppManifestShareRoute): string {
  const fieldMap = Object.entries(route.fieldMap ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([route.eventId, route.actionId, fieldMap]);
}

function hasWellFormedShareInviteContract(invite: PendingShareInvite): boolean {
  return Array.isArray(invite.events) && invite.events.every(isBindingDeclaration)
    && Array.isArray(invite.actions) && invite.actions.every(isBindingDeclaration)
    && Array.isArray(invite.routes) && invite.routes.length > 0 && invite.routes.every(isShareRoute);
}

/** Exact offered payload schemas and routes must be supported before a capability can install. */
export function isShareInviteCompatible(invite: PendingShareInvite, manifest: CodeAppManifest): boolean {
  if (!hasWellFormedShareInviteContract(invite)) return false;
  const share = manifest.channels?.shares?.find((candidate) => candidate.id === invite.shareId);
  if (!share) return false;
  const localEvents = new Map((manifest.bindings?.events ?? []).map((binding) => [binding.id, binding]));
  const localActions = new Map((manifest.bindings?.actions ?? []).map((binding) => [binding.id, binding]));
  if (!invite.events.every((offered) => {
    const local = localEvents.get(offered.id);
    if (!local) return false;
    return share.events.includes(offered.id) && payloadSignature(local) === payloadSignature(offered);
  })) return false;
  if (!invite.actions.every((offered) => {
    const local = localActions.get(offered.id);
    if (!local) return false;
    return share.actions.includes(offered.id) && payloadSignature(local) === payloadSignature(offered);
  })) return false;
  const localRoutes = new Set(share.routes.map(routeSignature));
  return invite.routes.every((route) => localRoutes.has(routeSignature(route)));
}
