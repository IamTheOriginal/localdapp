import { describe, it, expect } from 'vitest';
import { deriveConnectionCode, formatConnectionCode } from '../services/connectionCode.ts';

describe('connection code', () => {
  it('is 8 digits, the same for both devices, and different per device pair and per lobby', async () => {
    const code = await deriveConnectionCode('aaaabbbbccccdddd', '1111222233334444', 'lobby-1');
    expect(code).toMatch(/^\d{8}$/);
    expect(await deriveConnectionCode('1111222233334444', 'aaaabbbbccccdddd', 'lobby-1')).toBe(code);
    expect(await deriveConnectionCode('aaaabbbbccccdddd', '5555666677778888', 'lobby-1')).not.toBe(code);
    // Bound to the lobby: nothing can be ground in advance for a lobby that does not exist yet.
    expect(await deriveConnectionCode('aaaabbbbccccdddd', '1111222233334444', 'lobby-2')).not.toBe(code);
  });

  it('is deliberately slow to derive — that is what makes grinding for a collision expensive', async () => {
    const started = performance.now();
    await deriveConnectionCode(`fresh-${Math.random()}`, 'other', 'lobby-timing');
    expect(performance.now() - started).toBeGreaterThan(5); // one SHA-256 took microseconds
  });

  it('groups the digits for reading out loud and leaves placeholders alone', () => {
    expect(formatConnectionCode('12345678')).toBe('1234 5678');
    expect(formatConnectionCode('--------')).toBe('--------');
  });
});
