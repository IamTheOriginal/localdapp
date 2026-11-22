import * as Y from 'yjs';
import type { PairingRequest, Relationship, RelationshipControlCapability, RelationshipIdentity, RelationshipInvite } from '../types.ts';
import { createRelationshipIdentity } from './relationshipIdentity.ts';
import {
  createPairingRequest, createPairingResponse, createRelationshipInvite, hashPairingRequest,
  parseInviteUri, verifyAndDecryptPairingResponse, verifyCompactInviteAnnounce, verifyPairingRequest,
  type CompactInviteContext,
} from './relationshipProtocol.ts';
import {
  RelationshipPairingRoomManager, pairingAcks, pairingRequests, pairingResponses, type RelationshipPairingRoomDescriptor, type RelationshipPairingRoomHandle,
} from './relationshipPairingRoomManager.ts';
import { generateRoomPassword } from './store/docs.ts';
import { compareAndSetRelationshipControlCapability, completeRelationshipPairing, createRelationship, getRelationship } from './store/relationships.ts';

interface HostedInvite { relationshipId: string; invite: RelationshipInvite; roomId: string; }
interface JoiningSession { relationshipId: string; identity: RelationshipIdentity; invite: RelationshipInvite; request: PairingRequest; roomId: string; completed: boolean; cancelled: boolean; }
export interface RelationshipPairingRequestInfo { request: PairingRequest; valid: boolean; }
interface AcceptedRelationshipInvite { relationship: Relationship; request: PairingRequest; sessionId: string; lobby: RelationshipPairingRoomHandle; inviterDisplayName: string; }
/** peerDisplayName is the other side's self-asserted, signed name (requester's on approve, inviter's on complete). */
export interface CompletedRelationshipPairing { relationship: Relationship; capability: RelationshipControlCapability; control: RelationshipPairingRoomHandle; peerDisplayName: string; }

function pairingLobbyIndex(doc: Y.Doc): Y.Map<RelationshipPairingRoomDescriptor> {
  return doc.getMap<RelationshipPairingRoomDescriptor>('relationshipPairingLobbyIndex');
}

/**
 * Pairing survives dialog closes and app restarts: the hosted invite (with its
 * lobby credentials) and the joiner's signed request are persisted in the
 * local-only root doc until the pairing completes or is cancelled. Without
 * this, closing the invite popup used to strand the whole handshake.
 */
interface PersistedHostedInvite { relationshipId: string; invite: RelationshipInvite; uri: string }
interface PersistedJoiningSession { relationshipId: string; sessionId: string; invite: RelationshipInvite; request: PairingRequest }

function hostedInviteStore(doc: Y.Doc): Y.Map<PersistedHostedInvite> {
  return doc.getMap<PersistedHostedInvite>('relationshipPairingHostedInvites');
}

function joiningSessionStore(doc: Y.Doc): Y.Map<PersistedJoiningSession> {
  return doc.getMap<PersistedJoiningSession>('relationshipPairingJoiningSessions');
}

/** Lobby-doc map carrying the inviter's signed identity announce for compact invites. */
function inviteAnnounces(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>('inviteAnnounce');
}

/** Just enough invite shape for the room manager to open a compact-derived lobby. */
function compactLobbyStub(context: CompactInviteContext): RelationshipInvite {
  return {
    protocol: 'relationship-pairing-invite', schemaVersion: 1, inviteId: context.inviteId,
    pairContextId: context.pairContextId, lobbyRoomId: context.lobbyRoomId, lobbyRoomPassword: context.lobbyRoomPassword,
    publicKey: '', encPublicKey: '', displayName: '', createdAt: '', expiresAt: context.expiresAt, nonce: '', signature: '',
  };
}

export class RelationshipPairingRuntime {
  private readonly hosted = new Map<string, HostedInvite>();
  private readonly joining = new Map<string, JoiningSession>();
  private readonly cancelledRelationships = new Set<string>();
  private readonly pendingLobbyReleases = new Map<string, { timer: ReturnType<typeof setTimeout>; promise: Promise<void> }>();
  private readonly rootDoc: Y.Doc;
  private readonly rooms: RelationshipPairingRoomManager;
  private readonly now: () => Date;
  private readonly lobbyReleaseGraceMs: number;
  private readonly announceTimeoutMs: number;

  constructor(options: { rootDoc: Y.Doc; rooms: RelationshipPairingRoomManager; now?: () => Date; lobbyReleaseGraceMs?: number; announceTimeoutMs?: number }) {
    this.rootDoc = options.rootDoc; this.rooms = options.rooms; this.now = options.now ?? (() => new Date());
    this.lobbyReleaseGraceMs = options.lobbyReleaseGraceMs ?? 3000;
    this.announceTimeoutMs = options.announceTimeoutMs ?? 60_000;
  }

  async createInvite(relationshipId: string, options: { lifetimeMs?: number; displayName?: string } = {}): Promise<{ invite: RelationshipInvite; uri: string; lobby: RelationshipPairingRoomHandle }> {
    const relationship = this.requireRelationship(relationshipId);
    // A re-issue replaces the previous invite and its lobby for this relationship.
    if (pairingLobbyIndex(this.rootDoc).has(relationshipId) || hostedInviteStore(this.rootDoc).has(relationshipId)) {
      await this.releaseLobby(relationshipId);
    }
    const created = await createRelationshipInvite({ identity: relationship.localIdentity, lifetimeMs: options.lifetimeMs, now: this.now(), displayName: options.displayName });
    const lobby = this.rooms.openLobby(created.invite);
    // Compact codes carry no identity — joiners read this signed announce instead.
    inviteAnnounces(lobby.doc).set(created.invite.inviteId, created.invite);
    this.hosted.set(created.invite.inviteId, { relationshipId, invite: created.invite, roomId: lobby.descriptor.id });
    pairingLobbyIndex(this.rootDoc).set(relationshipId, lobby.descriptor);
    hostedInviteStore(this.rootDoc).set(relationshipId, { relationshipId, invite: created.invite, uri: created.uri });
    return { invite: created.invite, uri: created.uri, lobby };
  }

  connectInvite(inviteId: string): RelationshipPairingRoomHandle {
    const hosted = this.hosted.get(inviteId); if (!hosted) throw new Error('relationship pairing: Unknown hosted invite');
    return this.rooms.connect(hosted.roomId);
  }

  async acceptInvite(uri: string, personId: string, options: { relationshipId?: string; displayName?: string } = {}): Promise<AcceptedRelationshipInvite> {
    const context = await parseInviteUri(uri, this.now());
    if ([...this.joining.values()].some((value) => value.invite.inviteId === context.inviteId)) throw new Error('relationship pairing: Invite replay rejected');
    // The code only derives the lobby; the inviter's signed identity announce
    // is fetched live from inside it and verified against the derived context.
    const lobby = this.rooms.openLobby(compactLobbyStub(context));
    await lobby.persistenceReady;
    this.rooms.connect(lobby.descriptor.id);
    const invite = await this.awaitInviteAnnounce(lobby, context);
    const consumed = lobby.doc.getMap<string>('consumedInvites');
    if (consumed.has(invite.inviteId)) throw new Error('relationship pairing: Invite replay rejected');
    const identity = await createRelationshipIdentity();
    const relationship = createRelationship(personId, identity, { id: options.relationshipId }, this.rootDoc);
    const request = await createPairingRequest(invite, identity, this.now(), options.displayName);
    pairingRequests(lobby.doc).set(request.requestId, request);
    consumed.set(invite.inviteId, request.requestId);
    const sessionId = request.requestId;
    this.joining.set(sessionId, { relationshipId: relationship.id, identity, invite, request, roomId: lobby.descriptor.id, completed: false, cancelled: false });
    pairingLobbyIndex(this.rootDoc).set(relationship.id, lobby.descriptor);
    joiningSessionStore(this.rootDoc).set(relationship.id, { relationshipId: relationship.id, sessionId, invite, request });
    return { relationship, request, sessionId, lobby, inviterDisplayName: invite.displayName };
  }

  private awaitInviteAnnounce(lobby: RelationshipPairingRoomHandle, context: CompactInviteContext): Promise<RelationshipInvite> {
    const announces = inviteAnnounces(lobby.doc);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        announces.unobserve(check);
        clearTimeout(timer);
        settle();
      };
      const check = () => {
        const candidate = announces.get(context.inviteId);
        if (candidate === undefined) return;
        void verifyCompactInviteAnnounce(candidate, context, this.now()).then(
          (invite) => finish(() => resolve(invite)),
          (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
        );
      };
      const timer = setTimeout(() => finish(() => reject(new Error(
        'relationship pairing: The inviter is not reachable right now — ask them to open their app, then use the invite again',
      ))), this.announceTimeoutMs);
      announces.observe(check);
      check();
    });
  }

  connectSession(sessionId: string): RelationshipPairingRoomHandle {
    const session = this.requireSession(sessionId); return this.rooms.connect(session.roomId);
  }

  async listRequests(inviteId: string): Promise<RelationshipPairingRequestInfo[]> {
    const hosted = this.requireHosted(inviteId); const room = this.requireRoom(hosted.roomId); await room.persistenceReady; const doc = room.doc;
    return Promise.all([...pairingRequests(doc).values()].map(async (request) => ({ request, valid: await verifyPairingRequest(request, hosted.invite) })));
  }

  observeRequests(inviteId: string, listener: (requests: RelationshipPairingRequestInfo[]) => void): () => void {
    const hosted = this.requireHosted(inviteId); const map = pairingRequests(this.requireRoom(hosted.roomId).doc);
    let active = true; const emit = () => { void this.listRequests(inviteId).then((values) => { if (active) listener(values); }); };
    map.observe(emit); emit(); return () => { active = false; map.unobserve(emit); };
  }

  async approve(inviteId: string, requestId: string): Promise<CompletedRelationshipPairing> {
    const hosted = this.requireHosted(inviteId);
    this.assertNotCancelled(hosted.relationshipId);
    const room = this.requireRoom(hosted.roomId);
    await room.persistenceReady;
    this.assertNotCancelled(hosted.relationshipId);
    const lobby = room.doc;
    const approved = lobby.getMap<string>('approvedInvites');
    if (approved.has(inviteId)) throw new Error('relationship pairing: Invite already consumed');
    const request = pairingRequests(lobby).get(requestId);
    if (!request || !await verifyPairingRequest(request, hosted.invite)) throw new Error('relationship pairing: Invalid pairing request');
    this.assertNotCancelled(hosted.relationshipId);
    const capability: RelationshipControlCapability = {
      protocol: 'relationship-control-capability', schemaVersion: 1, capabilityId: crypto.randomUUID(), pairContextId: hosted.invite.pairContextId,
      roomId: `relationship-control-v1-${crypto.randomUUID()}`, roomPassword: generateRoomPassword(), createdAt: this.now().toISOString(),
    };
    const relationship = this.requireRelationship(hosted.relationshipId);
    const response = await createPairingResponse(hosted.invite, relationship.localIdentity, request, capability, this.now());
    const transcriptHash = await hashPairingRequest(request);
    this.assertNotCancelled(hosted.relationshipId);
    let completed!: Relationship;
    this.rootDoc.transact(() => {
      this.assertNotCancelled(hosted.relationshipId);
      compareAndSetRelationshipControlCapability(relationship.id, null, capability, this.rootDoc);
      completed = completeRelationshipPairing(relationship.id, {
        publicKey: request.requesterPublicKey, encPublicKey: request.requesterEncPublicKey, pairContextId: hosted.invite.pairContextId,
        controlCapabilityId: capability.capabilityId, transcriptHash,
      }, this.rootDoc);
    }, 'approve-relationship-pairing');
    lobby.transact(() => { approved.set(inviteId, requestId); pairingResponses(lobby).set(requestId, response); });
    hostedInviteStore(this.rootDoc).delete(hosted.relationshipId);
    // The joiner still needs the response from this lobby; release it only once its
    // completion ack arrives (the sweep covers acks that arrive after a restart).
    const acks = pairingAcks(lobby);
    const onAck = () => {
      if (!acks.has(requestId)) return;
      acks.unobserve(onAck);
      this.scheduleLobbyRelease(hosted.relationshipId);
    };
    acks.observe(onAck);
    onAck();
    const control = this.rooms.openControl(capability, completed.localIdentity.publicKey);
    return { relationship: completed, capability, control, peerDisplayName: request.displayName };
  }

  async complete(sessionId: string): Promise<CompletedRelationshipPairing | null> {
    const session = this.requireSession(sessionId);
    if (session.cancelled) return null;
    if (session.completed) throw new Error('relationship pairing: Response replay rejected');
    const room = this.requireRoom(session.roomId); await room.persistenceReady;
    if (session.cancelled) return null;
    const response = pairingResponses(room.doc).get(session.request.requestId);
    if (!response) return null;
    const capability = await verifyAndDecryptPairingResponse(response, session.request, session.identity);
    if (session.cancelled || this.cancelledRelationships.has(session.relationshipId)) return null;
    const transcriptHash = await hashPairingRequest(session.request);
    if (session.cancelled || this.cancelledRelationships.has(session.relationshipId)) return null;
    let relationship!: Relationship;
    this.rootDoc.transact(() => {
      if (session.cancelled || this.cancelledRelationships.has(session.relationshipId)) return;
      compareAndSetRelationshipControlCapability(session.relationshipId, null, capability, this.rootDoc);
      relationship = completeRelationshipPairing(session.relationshipId, {
        publicKey: session.invite.publicKey, encPublicKey: response.inviterEncPublicKey, pairContextId: session.invite.pairContextId,
        controlCapabilityId: capability.capabilityId, transcriptHash,
      }, this.rootDoc);
      session.completed = true;
    }, 'complete-relationship-pairing');
    if (!relationship) return null;
    joiningSessionStore(this.rootDoc).delete(session.relationshipId);
    // Tell the inviter we have the capability, give the ack a moment to flush, then
    // let go of the one-time lobby — it has served its purpose.
    pairingAcks(room.doc).set(session.request.requestId, this.now().toISOString());
    this.scheduleLobbyRelease(session.relationshipId);
    const control = this.rooms.openControl(capability, relationship.localIdentity.publicKey);
    return { relationship, capability, control, peerDisplayName: session.invite.displayName };
  }

  observeCompletion(sessionId: string, listener: (result: CompletedRelationshipPairing) => void): () => void {
    const session = this.requireSession(sessionId); const map = pairingResponses(this.requireRoom(session.roomId).doc);
    let active = true, running = false; const emit = () => { if (running || session.completed) return; running = true; void this.complete(sessionId).then((result) => { if (result && active) listener(result); }).finally(() => { running = false; }); };
    map.observe(emit); emit(); return () => { active = false; map.unobserve(emit); };
  }

  /** Stops any live lobby/session for an incomplete local relationship and clears its persisted lobby state. */
  async cancelRelationship(relationshipId: string): Promise<void> {
    this.cancelledRelationships.add(relationshipId);
    for (const session of this.joining.values()) {
      if (session.relationshipId !== relationshipId) continue;
      session.cancelled = true;
      session.completed = true;
    }
    await this.releaseLobby(relationshipId);
  }

  /** Tears down every lobby room of a relationship — providers, persistence, and index entry. */
  private async releaseLobby(relationshipId: string): Promise<void> {
    const roomIds = new Set<string>();
    const indexedDescriptor = pairingLobbyIndex(this.rootDoc).get(relationshipId);
    if (indexedDescriptor) roomIds.add(indexedDescriptor.id);
    for (const [inviteId, hosted] of this.hosted) {
      if (hosted.relationshipId !== relationshipId) continue;
      roomIds.add(hosted.roomId);
      this.hosted.delete(inviteId);
    }
    for (const [sessionId, session] of this.joining) {
      if (session.relationshipId !== relationshipId) continue;
      roomIds.add(session.roomId);
      this.joining.delete(sessionId);
    }
    if (indexedDescriptor) await this.rooms.destroyDescriptor(indexedDescriptor);
    await Promise.all([...roomIds]
      .filter((roomId) => roomId !== indexedDescriptor?.id)
      .map((roomId) => this.rooms.destroy(roomId, { clearPersistence: true })));
    pairingLobbyIndex(this.rootDoc).delete(relationshipId);
    hostedInviteStore(this.rootDoc).delete(relationshipId);
    joiningSessionStore(this.rootDoc).delete(relationshipId);
  }

  /**
   * Rehydrates a persisted hosted invite so its URI can be shown again and its
   * requests approved — after the dialog closed or the app restarted. Expired
   * invites are reported (for a re-issue prompt), not silently dropped.
   */
  resumeHostedInvite(relationshipId: string): { inviteId: string; uri: string; expiresAt: string; expired: boolean } | null {
    const entry = hostedInviteStore(this.rootDoc).get(relationshipId);
    if (!entry) return null;
    const relationship = getRelationship(relationshipId, this.rootDoc);
    if (!relationship || relationship.status !== 'pending') return null;
    const expired = this.now().getTime() > Date.parse(entry.invite.expiresAt);
    if (!expired && !this.hosted.has(entry.invite.inviteId)) {
      const lobby = this.rooms.openLobby(entry.invite);
      inviteAnnounces(lobby.doc).set(entry.invite.inviteId, entry.invite);
      this.hosted.set(entry.invite.inviteId, { relationshipId, invite: entry.invite, roomId: lobby.descriptor.id });
      pairingLobbyIndex(this.rootDoc).set(relationshipId, lobby.descriptor);
      this.rooms.connect(lobby.descriptor.id);
    }
    return { inviteId: entry.invite.inviteId, uri: entry.uri, expiresAt: entry.invite.expiresAt, expired };
  }

  /** Rehydrates every persisted pairing after a restart; returns joining session ids to observe for completion. */
  resumePersistedPairings(): { joiningSessions: string[] } {
    for (const relationshipId of [...hostedInviteStore(this.rootDoc).keys()]) {
      try { this.resumeHostedInvite(relationshipId); } catch (error) { console.error('Could not resume hosted pairing invite', error); }
    }
    const joiningSessions: string[] = [];
    for (const entry of [...joiningSessionStore(this.rootDoc).values()]) {
      try {
        const relationship = getRelationship(entry.relationshipId, this.rootDoc);
        if (!relationship || relationship.status !== 'pending') {
          joiningSessionStore(this.rootDoc).delete(entry.relationshipId);
          continue;
        }
        if (!this.joining.has(entry.sessionId)) {
          const lobby = this.rooms.openLobby(entry.invite);
          this.joining.set(entry.sessionId, {
            relationshipId: entry.relationshipId, identity: relationship.localIdentity, invite: entry.invite,
            request: entry.request, roomId: lobby.descriptor.id, completed: false, cancelled: false,
          });
          pairingLobbyIndex(this.rootDoc).set(entry.relationshipId, lobby.descriptor);
          // Idempotent re-publish keeps the signed request present even if the
          // lobby persistence was lost with the previous install.
          pairingRequests(lobby.doc).set(entry.request.requestId, entry.request);
        }
        joiningSessions.push(entry.sessionId);
      } catch (error) {
        console.error('Could not resume joining pairing session', error);
      }
    }
    return { joiningSessions };
  }

  /** Which side of an incomplete pairing this device holds, if any. */
  pendingPairingKind(relationshipId: string): 'hosted' | 'joining' | null {
    if (hostedInviteStore(this.rootDoc).has(relationshipId)) return 'hosted';
    if (joiningSessionStore(this.rootDoc).has(relationshipId)) return 'joining';
    return null;
  }

  /**
   * What a pending pairing's safety number is derived from — available BEFORE the pairing
   * completes, so both sides can compare it before anyone approves. The joining side knows
   * the inviter's key from the code-gated, signed announce; the hosting side only learns the
   * other key with each request, so the caller passes it (`peerPublicKey` is null there).
   */
  pendingPairingParties(relationshipId: string): { localPublicKey: string; pairContextId: string; peerPublicKey: string | null } | null {
    const relationship = getRelationship(relationshipId, this.rootDoc);
    if (!relationship || relationship.status !== 'pending') return null;
    const hosted = hostedInviteStore(this.rootDoc).get(relationshipId);
    if (hosted) {
      return { localPublicKey: relationship.localIdentity.publicKey, pairContextId: hosted.invite.pairContextId, peerPublicKey: null };
    }
    const joining = joiningSessionStore(this.rootDoc).get(relationshipId);
    if (joining) {
      return {
        localPublicKey: relationship.localIdentity.publicKey,
        pairContextId: joining.invite.pairContextId,
        peerPublicKey: joining.invite.publicKey || null,
      };
    }
    return null;
  }

  /** Defers a lobby release long enough for a just-written ack to reach connected peers. */
  private scheduleLobbyRelease(relationshipId: string): void {
    if (this.pendingLobbyReleases.has(relationshipId)) return;
    let timer!: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        void this.releaseLobby(relationshipId)
          .catch((error: unknown) => console.error('Could not release pairing lobby', error))
          .then(() => { this.pendingLobbyReleases.delete(relationshipId); resolve(); });
      }, this.lobbyReleaseGraceMs);
    });
    this.pendingLobbyReleases.set(relationshipId, { timer, promise });
  }

  /** Awaits every scheduled lobby release (test hook — production releases are fire-and-forget). */
  async settleLobbyReleases(): Promise<void> {
    while (this.pendingLobbyReleases.size > 0) {
      await Promise.all([...this.pendingLobbyReleases.values()].map((entry) => entry.promise));
    }
  }

  /** Drops scheduled releases without running them (test hook simulating an abrupt shutdown). */
  disposeScheduledLobbyReleases(): void {
    for (const entry of this.pendingLobbyReleases.values()) clearTimeout(entry.timer);
    this.pendingLobbyReleases.clear();
  }

  /**
   * Releases pairing lobbies whose job is done: the relationship completed (status
   * 'active') or no longer exists. Run at startup — it covers acks that were lost to a
   * restart on either side. The joiner re-writes its ack; the inviter releases on ack.
   */
  async sweepCompletedPairingLobbies(): Promise<void> {
    for (const [relationshipId, descriptor] of [...pairingLobbyIndex(this.rootDoc).entries()]) {
      try {
        const relationship = getRelationship(relationshipId, this.rootDoc);
        if (!relationship) {
          await this.releaseLobby(relationshipId);
          continue;
        }
        if (relationship.status !== 'active') continue; // pairing still in progress
        const handle = this.rooms.get(descriptor.id) ?? this.rooms.openDescriptor(descriptor);
        await handle.persistenceReady;
        const requests = pairingRequests(handle.doc);
        const acks = pairingAcks(handle.doc);
        if (requests.size === 0 && pairingResponses(handle.doc).size === 0) {
          await this.releaseLobby(relationshipId); // nothing recoverable — plain remnant
          continue;
        }
        const myRequest = [...requests.values()]
          .find((request) => request.requesterPublicKey === relationship.localIdentity.publicKey);
        if (myRequest) {
          // We joined through this lobby: leave a durable ack for the inviter, then let go.
          acks.set(myRequest.requestId, this.now().toISOString());
          this.rooms.connect(descriptor.id);
          this.scheduleLobbyRelease(relationshipId);
        } else if (acks.size > 0) {
          await this.releaseLobby(relationshipId);
        } else {
          // We hosted and the joiner's ack has not arrived yet — wait for it live.
          const onAck = () => {
            if (acks.size === 0) return;
            acks.unobserve(onAck);
            this.scheduleLobbyRelease(relationshipId);
          };
          acks.observe(onAck);
          this.rooms.connect(descriptor.id);
          onAck();
        }
      } catch (error) {
        console.error('Could not sweep pairing lobby', error);
      }
    }
  }

  private assertNotCancelled(relationshipId: string): void {
    if (this.cancelledRelationships.has(relationshipId)) throw new Error('relationship pairing: Pairing was cancelled');
  }

  private requireRelationship(id: string): Relationship { const value = getRelationship(id, this.rootDoc); if (!value) throw new Error(`relationship pairing: Unknown relationship ${id}`); return value; }
  private requireHosted(id: string): HostedInvite { const value = this.hosted.get(id); if (!value) throw new Error('relationship pairing: Unknown hosted invite'); return value; }
  private requireSession(id: string): JoiningSession { const value = this.joining.get(id); if (!value) throw new Error('relationship pairing: Unknown joining session'); return value; }
  private requireRoom(id: string): RelationshipPairingRoomHandle { const value = this.rooms.get(id); if (!value) throw new Error('relationship pairing: Room is not open'); return value; }
}
