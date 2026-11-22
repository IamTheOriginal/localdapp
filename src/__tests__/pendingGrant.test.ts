import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmPendingAccessGrant, forgetAccessGrants, getPendingAccessGrant, isGranterRefused, listPendingAccessGrants,
  offerAccessGrant, onPendingAccessGrantsChange, refusePendingAccessGrant, setAccessGrantAutoConfirm,
} from '../services/store/pendingGrant.ts';

const REAL_OWNER = 'aa'.repeat(32);
const EVIL_TWIN = 'ee'.repeat(32);

function offer(dappId: string, approvedBy: string, code: string, approverName = 'Owner device') {
  const accept = vi.fn();
  const discard = vi.fn();
  offerAccessGrant({ dappId, approvedBy, approverName, code, accept, discard });
  return { accept, discard };
}

afterEach(() => {
  setAccessGrantAutoConfirm(null);
  ['dapp-1', 'dapp-2'].forEach(forgetAccessGrants);
});

describe('held credential grants (evil-twin owner in an invite lobby)', () => {
  it('does not use an approval until the person confirmed it', () => {
    const changes = vi.fn();
    const stop = onPendingAccessGrantsChange(changes);
    const { accept } = offer('dapp-1', REAL_OWNER, '12345678', 'Alice PC');

    expect(accept).not.toHaveBeenCalled();
    expect(getPendingAccessGrant('dapp-1')).toEqual({ dappId: 'dapp-1', approvedBy: REAL_OWNER, approverName: 'Alice PC', code: '12345678' });
    expect(changes).toHaveBeenCalledTimes(1);

    expect(confirmPendingAccessGrant('dapp-1')).toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(getPendingAccessGrant('dapp-1')).toBeNull();
    expect(confirmPendingAccessGrant('dapp-1')).toBe(false);
    stop();
  });

  it('refusing the twin keeps the device waiting, ignores the twin from then on and still takes the real owner', () => {
    const twin = offer('dapp-1', EVIL_TWIN, '99990000', 'Alice PC');
    expect(refusePendingAccessGrant('dapp-1')).toBe(true);
    expect(twin.accept).not.toHaveBeenCalled();
    expect(twin.discard).toHaveBeenCalledTimes(1);
    expect(isGranterRefused('dapp-1', EVIL_TWIN)).toBe(true);

    // The twin writes its grant again (the lobby doc is writable by every link holder): ignored.
    const again = offer('dapp-1', EVIL_TWIN, '99990000', 'Alice PC');
    expect(getPendingAccessGrant('dapp-1')).toBeNull();
    expect(again.accept).not.toHaveBeenCalled();

    const real = offer('dapp-1', REAL_OWNER, '12345678', 'Alice PC');
    expect(getPendingAccessGrant('dapp-1')?.approvedBy).toBe(REAL_OWNER);
    confirmPendingAccessGrant('dapp-1');
    expect(real.accept).toHaveBeenCalledTimes(1);
    // A refusal is per dapp.
    expect(isGranterRefused('dapp-2', EVIL_TWIN)).toBe(false);
  });

  it('shows the latest approval when a second device approves before the person decided', () => {
    const first = offer('dapp-1', EVIL_TWIN, '99990000');
    const second = offer('dapp-1', REAL_OWNER, '12345678');
    expect(getPendingAccessGrant('dapp-1')?.code).toBe('12345678');
    confirmPendingAccessGrant('dapp-1');
    expect(first.accept).not.toHaveBeenCalled();
    expect(second.accept).toHaveBeenCalledTimes(1);
  });

  it('does not announce the same held approval again and again', () => {
    const changes = vi.fn();
    const stop = onPendingAccessGrantsChange(changes);
    offer('dapp-1', REAL_OWNER, '12345678');
    offer('dapp-1', REAL_OWNER, '12345678');
    offer('dapp-1', REAL_OWNER, '12345678');
    expect(changes).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a device without a person decides by the approving key (keeper: its operators)', () => {
    setAccessGrantAutoConfirm((_dappId, approvedBy) => approvedBy === REAL_OWNER);
    const operator = offer('dapp-1', REAL_OWNER, '12345678');
    expect(operator.accept).toHaveBeenCalledTimes(1);
    expect(getPendingAccessGrant('dapp-1')).toBeNull();

    const stranger = offer('dapp-2', EVIL_TWIN, '99990000');
    expect(stranger.accept).not.toHaveBeenCalled();
    expect(listPendingAccessGrants().map((grant) => grant.dappId)).toEqual(['dapp-2']);
  });

  it('forgets held and refused approvals when the dapp is removed from the device', () => {
    offer('dapp-1', EVIL_TWIN, '99990000');
    refusePendingAccessGrant('dapp-1');
    offer('dapp-1', REAL_OWNER, '12345678');
    forgetAccessGrants('dapp-1');
    expect(getPendingAccessGrant('dapp-1')).toBeNull();
    expect(isGranterRefused('dapp-1', EVIL_TWIN)).toBe(false);
  });
});
