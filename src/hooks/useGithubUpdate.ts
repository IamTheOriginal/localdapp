import { useEffect, useState } from 'react';
import { getGithubOrigin, observeGithubOrigin, type GithubOrigin } from '../services/store/githubOrigin.ts';
import {
  checkGithubUpdate, githubSourceMismatch, isGithubUpdateAvailable, readGithubUpdateCheck, subscribeGithubUpdateChecks, type GithubUpdateCheck,
} from '../services/githubUpdateState.ts';
import { useMyRole } from './useYjs.ts';

interface GithubUpdateState {
  origin: GithubOrigin | null;
  check: GithubUpdateCheck | null;
  /** True only for owners of a GitHub-linked dapp whose tracked folder changed since the installed revision. */
  updateAvailable: boolean;
  /** The synced link points somewhere else than the repository this device accepted — needs an owner's look. */
  sourceChanged: boolean;
}

const EMPTY: GithubUpdateState = { origin: null, check: null, updateAvailable: false, sourceChanged: false };

/**
 * GitHub link + update marker of one dapp, for owners only (everyone else
 * always gets the empty state, so no marker and no GitHub request). Mounting
 * it runs the rate-limited background check — at most one GitHub call per
 * dapp every six hours on this device.
 */
export function useGithubUpdate(dappId: string | undefined): GithubUpdateState {
  const isOwner = useMyRole(dappId) === 'owner';
  const [state, setState] = useState<GithubUpdateState & { dappId: string }>({ dappId: '', ...EMPTY });

  useEffect(() => {
    if (!dappId || !isOwner) return;
    let lastAutoCheckFor = '';
    const refresh = () => {
      const origin = getGithubOrigin(dappId);
      const check = origin ? readGithubUpdateCheck(dappId, origin) : null;
      const sourceChanged = origin ? githubSourceMismatch(dappId, origin) !== null : false;
      setState({ dappId, origin, check, updateAvailable: !sourceChanged && isGithubUpdateAvailable(origin, check), sourceChanged });
      // The origin arrives asynchronously with the source doc; (re)try the
      // background check once per distinct installed revision.
      const autoKey = origin ? `${origin.commitSha}:${origin.fingerprint}` : '';
      if (origin && autoKey !== lastAutoCheckFor) {
        lastAutoCheckFor = autoKey;
        checkGithubUpdate(dappId).catch(() => undefined); // offline / rate limited — retried on the next visit
      }
    };
    refresh();
    const stopOrigin = observeGithubOrigin(dappId, refresh);
    const stopChecks = subscribeGithubUpdateChecks(refresh);
    return () => { stopOrigin(); stopChecks(); };
  }, [dappId, isOwner]);

  return dappId && isOwner && state.dappId === dappId ? state : EMPTY;
}
