/**
 * The connection code two devices compare before an owner lets a device in.
 *
 * It used to be 6 digits of one SHA-256 over the two public keys: about a million
 * key generations — seconds — let anyone holding the invite link find a key whose
 * code collides with the code of the device the owner expects, and get approved in
 * its place. Two changes make that a different order of effort:
 *  - 8 digits instead of 6 (100× more candidates), and
 *  - every candidate costs a PBKDF2 stretch instead of one hash, bound to the lobby,
 *    so nothing can be precomputed before the victim shows up in that lobby.
 * A collision now has to be found by brute force while the victim is waiting.
 * Both sides derive it once per device pair (cached).
 */

const ITERATIONS = 300_000;
const DIGITS = 8;
const cache = new Map<string, Promise<string>>();

export function deriveConnectionCode(publicKeyA: string, publicKeyB: string, lobbyId: string): Promise<string> {
  const pair = [publicKeyA, publicKeyB].sort().join(':');
  const cacheKey = `${lobbyId}|${pair}`;
  let code = cache.get(cacheKey);
  if (!code) {
    code = (async () => {
      const encoder = new TextEncoder();
      const material = await crypto.subtle.importKey('raw', encoder.encode(pair), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: encoder.encode(`vibedapp-connection-code-v2:${lobbyId}`), iterations: ITERATIONS, hash: 'SHA-256' },
        material,
        64,
      );
      const value = new DataView(bits).getBigUint64(0, false) % (10n ** BigInt(DIGITS));
      return value.toString().padStart(DIGITS, '0');
    })();
    if (cache.size > 500) cache.clear();
    cache.set(cacheKey, code);
    code.catch(() => cache.delete(cacheKey));
  }
  return code;
}

/** `12345678` → `1234 5678` — easier to read out loud; placeholders pass through. */
export function formatConnectionCode(code: string): string {
  return /^\d{8}$/.test(code) ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}
