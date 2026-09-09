/** Byte <-> string helpers shared by the crypto and password modules below. */

export function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBuf(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

export function bytesToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlFromBase64(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64FromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return padded + padding;
}

export function bytesToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  return base64UrlFromBase64(bytesToBase64(buffer));
}
export function base64UrlToBytes(value: string): Uint8Array {
  return base64ToBytes(base64FromBase64Url(value));
}

export function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}
export function base64UrlToText(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

/** Constant-time equality, so a token/hash comparison can't leak timing information. */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) diff |= aBytes[i]! ^ bBytes[i]!;
  return diff === 0;
}
