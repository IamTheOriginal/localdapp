import { expect } from 'vitest';

/**
 * Byte-for-byte equality without `toEqual`: Vitest's deep equality walks a typed array
 * element by element (~1.4 s per 500 KB), which made the blob tests slow and, under load,
 * flaky against the default timeout.
 */
export function expectSameBytes(actual: Uint8Array | null | undefined, expected: Uint8Array): void {
  expect(actual, 'expected bytes, got nothing').toBeTruthy();
  const bytes = actual as Uint8Array;
  expect(bytes.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))).toBe(0);
}
