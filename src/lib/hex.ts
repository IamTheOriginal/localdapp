/**
 * Canonical hex codecs shared across identity, protocol, and stream modules.
 * Strict/validating variants (relationshipProtocol.hexToBytes,
 * relationshipStream.strictHex) are intentionally separate — different
 * contracts, not duplication.
 */

export function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}
