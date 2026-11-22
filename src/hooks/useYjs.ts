import { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { buildHomeLayout, flattenHomeOrder, readCatalogItems, readFolders, getDappDoc, getRootDoc, getDappConfig, getDappSourceDoc, getDappSourcePersistence } from '../services/store/index.ts';
import { getMeshPeerKeys, subscribeMeshPeers } from '../services/meshPresence.ts';
import { getIdentity } from '../services/identity.ts';
import type { DappListItem, HomeNode, DappConfig, InviteDef, CodeAppManifest, MemberRole } from '../types.ts';
import { parseCodeAppManifest } from '../services/codeAppManifest.ts';
import { getSourceSealState, subscribeSourceSeal, type SourceSealState } from '../services/store/sourceSeal.ts';

export interface HomeLayoutState {
  /** Top-level Home entries (dapps and folders) in the saved manual order. */
  nodes: HomeNode[];
  /** Archived read-only copies ("Left apps"); they take no part in the layout. */
  leftDapps: DappListItem[];
}

const EMPTY_HOME_LAYOUT: HomeLayoutState = { nodes: [], leftDapps: [] };

/**
 * Subscribe to the root doc's catalog and folders as the Home layout
 * (`store/homeLayout.ts`). The order is per device — the root doc never syncs.
 */
export function useHomeLayout(): HomeLayoutState {
  const [layout, setLayout] = useState<HomeLayoutState>(EMPTY_HOME_LAYOUT);

  useEffect(() => {
    const rootDoc = getRootDoc();
    const refresh = () => {
      const items = readCatalogItems(rootDoc);
      setLayout({
        nodes: buildHomeLayout(items, readFolders(rootDoc)),
        leftDapps: items.filter((item) => item.archivedAt),
      });
    };

    refresh();
    rootDoc.on('update', refresh);
    return () => { rootDoc.off('update', refresh); };
  }, []);

  return layout;
}

/**
 * The dapps catalog as plain JS objects, in Home layout order (folder members
 * inline at their folder's position), archived copies last.
 */
export function useDappsList(): DappListItem[] {
  const { nodes, leftDapps } = useHomeLayout();
  return useMemo(() => [...flattenHomeOrder(nodes), ...leftDapps], [nodes, leftDapps]);
}

/**
 * Subscribe to a dapp's config and return the parsed config object.
 */
export function useDappConfig(dappId: string | undefined): DappConfig | null {
  // The value is tagged with its dapp id so a hook that outlives a dapp page (the
  // AppShell sidebar stays mounted across Home and dapp routes) never reports the
  // previous dapp's config after the id changed or went away.
  const [state, setState] = useState<{ dappId: string; config: DappConfig | null }>({ dappId: '', config: null });

  useEffect(() => {
    if (!dappId) return;

    // Only the `config` map feeds the result. Listening to every doc update
    // rebuilt the schema and re-rendered the whole shell for each record write
    // (and each auth revert, each file, each sync burst).
    const configMap = getDappDoc(dappId).getMap('config');
    let serialized = '';
    const refresh = () => {
      const config = getDappConfig(dappId);
      const nextSerialized = JSON.stringify(config);
      // Same content → keep the previous object, so consumers and effects stay quiet.
      setState((previous) => {
        if (previous.dappId === dappId && nextSerialized === serialized) return previous;
        serialized = nextSerialized;
        return { dappId, config };
      });
    };

    // Wait for indexeddb to load
    const timer = setTimeout(refresh, 100);
    configMap.observeDeep(refresh);

    return () => {
      clearTimeout(timer);
      configMap.unobserveDeep(refresh);
    };
  }, [dappId]);

  return dappId && state.dappId === dappId ? state.config : null;
}

/** Subscribe to all files in the isolated Code App source document. */
export function useCodeAppFiles(dappId: string | undefined): {
  files: Record<string, string>;
  localReady: boolean;
} {
  const [state, setState] = useState<{
    dappId: string;
    files: Record<string, string>;
    localReady: boolean;
  }>({ dappId: '', files: {}, localReady: false });

  useEffect(() => {
    if (!dappId) return;

    const activeDappId = dappId;
    const doc = getDappSourceDoc(activeDappId);
    const filesMap = doc.getMap<Y.Text>('files');
    const snapshot = () => {
      const files: Record<string, string> = {};
      filesMap.forEach((file, path) => {
        files[path] = file instanceof Y.Text ? file.toJSON() : '';
      });
      return files;
    };
    const refresh = () => {
      setState((previous) => ({
        dappId: activeDappId,
        files: snapshot(),
        localReady: previous.dappId === activeDappId ? previous.localReady : false,
      }));
    };

    refresh();
    filesMap.observeDeep(refresh);

    let active = true;
    const persistence = getDappSourcePersistence(activeDappId);
    if (persistence) {
      void persistence.whenSynced.then(() => {
        if (!active) return;
        setState({ dappId: activeDappId, files: snapshot(), localReady: true });
      });
    } else {
      queueMicrotask(() => {
        if (active) setState({ dappId: activeDappId, files: snapshot(), localReady: true });
      });
    }

    return () => {
      active = false;
      filesMap.unobserveDeep(refresh);
    };
  }, [dappId]);

  return state.dappId === dappId
    ? { files: state.files, localReady: state.localReady }
    : { files: {}, localReady: false };
}

const NO_FILES: Record<string, string> = {};
const NO_SEAL_STATE: SourceSealState = { status: 'pending', files: null };

/**
 * The Code App source that may RUN on this device: the snapshot matching a valid owner
 * seal (sourceSeal.ts), not whatever currently sits in the synced doc. `status` tells the
 * runtime when the live source is being held back (`held`) or nothing may run (`blocked`).
 * The editor keeps using `useCodeAppFiles` — it edits the live doc.
 */
export function useRunnableCodeApp(dappId: string | undefined): {
  files: Record<string, string>;
  localReady: boolean;
  status: SourceSealState['status'];
  reason: string | undefined;
} {
  const subscribe = useCallback((listener: () => void) => (dappId ? subscribeSourceSeal(dappId, listener) : () => undefined), [dappId]);
  const state = useSyncExternalStore(subscribe, () => (dappId ? getSourceSealState(dappId) : NO_SEAL_STATE));
  return { files: state.files ?? NO_FILES, localReady: state.status !== 'pending', status: state.status, reason: state.reason };
}

/** Subscribe to and validate manifest.yaml of the runnable (owner-sealed) Code App source. */
export function useCodeAppManifest(dappId: string | undefined): {
  manifest: CodeAppManifest;
  error: string | null;
  localReady: boolean;
} {
  const { files, localReady } = useRunnableCodeApp(dappId);
  const yaml = files['manifest.yaml'] ?? '';
  return useMemo(() => ({ ...parseManifestCached(yaml), localReady }), [yaml, localReady]);
}

// The shell mounts this hook several times per dapp page (sidebar, mobile drawer,
// page, runtime). Parsing the YAML per instance and per render was wasted work, and
// it handed out a new `routes` array every time, which re-ran route effects. One
// parse per distinct manifest text, shared by all instances.
const manifestParseCache = new Map<string, ReturnType<typeof parseCodeAppManifest>>();
const MANIFEST_PARSE_CACHE_SIZE = 8;

function parseManifestCached(yaml: string): ReturnType<typeof parseCodeAppManifest> {
  const cached = manifestParseCache.get(yaml);
  if (cached) return cached;
  const parsed = parseCodeAppManifest(yaml);
  if (manifestParseCache.size >= MANIFEST_PARSE_CACHE_SIZE) {
    const oldest = manifestParseCache.keys().next().value;
    if (oldest !== undefined) manifestParseCache.delete(oldest);
  }
  manifestParseCache.set(yaml, parsed);
  return parsed;
}

/** Awareness entry for one connected peer: clientId plus whatever state the peer published. */
const NO_PEERS: string[] = [];

/**
 * Other devices connected to this dapp right now: the verified member keys of
 * every ready session in the member mesh (this device excluded). Opening the
 * dapp doc is what brings the mesh up.
 */
export function usePeers(dappId: string | undefined): string[] {
  useEffect(() => {
    if (dappId) getDappDoc(dappId);
  }, [dappId]);
  const subscribe = useCallback(
    (onChange: () => void) => (dappId ? subscribeMeshPeers(dappId, onChange) : () => undefined),
    [dappId],
  );
  return useSyncExternalStore(subscribe, () => (dappId ? getMeshPeerKeys(dappId) : NO_PEERS));
}

export function useInvites(dappId?: string): InviteDef[] {
  const [invites, setInvites] = useState<InviteDef[]>([]);

  useEffect(() => {
    if (!dappId) return;
    
    const doc = getDappDoc(dappId);
    const invitesMap = doc.getMap('invites');
    
    const refresh = () => {
      const arr: InviteDef[] = [];
      invitesMap.forEach((val) => {
        const map = val as Y.Map<unknown>;
        const invite: Record<string, unknown> = {};
        map.forEach((v, k) => { invite[k] = v; });
        // Invite maps carry exactly the InviteDef keys written by createInvite.
        arr.push(invite as unknown as InviteDef);
      });
      setInvites(arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    };

    refresh();
    invitesMap.observe(refresh);
    return () => {
      invitesMap.unobserve(refresh);
    };
  }, [dappId]);

  return invites;
}

interface DappMember { publicKey: string; name: string; role: string }

/** Subscribe to a dapp's members map as plain rows (name is '' when unset). */
export function useDappMembers(dappId: string | undefined): DappMember[] {
  const [members, setMembers] = useState<DappMember[]>([]);

  useEffect(() => {
    if (!dappId) return;
    const membersMap = getDappDoc(dappId).getMap('members');
    const refresh = () => {
      const rows: DappMember[] = [];
      membersMap.forEach((value, publicKey) => {
        const member = value as Y.Map<unknown>;
        const name = member.get('name');
        const role = member.get('role');
        rows.push({
          publicKey,
          name: typeof name === 'string' ? name : '',
          role: typeof role === 'string' ? role : 'viewer',
        });
      });
      setMembers(rows);
    };
    refresh();
    membersMap.observeDeep(refresh);
    return () => membersMap.unobserveDeep(refresh);
  }, [dappId]);

  return members;
}

export function useMyRole(dappId?: string): MemberRole | null {
  const [state, setState] = useState<{ dappId: string; role: MemberRole | null }>({ dappId: '', role: null });

  useEffect(() => {
    if (!dappId) return;
    const identity = getIdentity();
    if (!identity) return;

    const doc = getDappDoc(dappId);
    const membersMap = doc.getMap('members');

    const refresh = () => {
      const member = membersMap.get(identity.publicKey) as Y.Map<unknown> | undefined;
      setState({ dappId, role: member ? ((member.get('role') as MemberRole) || 'editor') : null });
    };

    refresh();
    membersMap.observeDeep(refresh);
    
    return () => {
      membersMap.unobserveDeep(refresh);
    };
  }, [dappId]);

  return dappId && state.dappId === dappId ? state.role : null;
}

