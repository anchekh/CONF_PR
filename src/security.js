import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHex] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
      const separator = item.indexOf('=');
      if (separator < 0) return [item, ''];
      return [item.slice(0, separator), decodeURIComponent(item.slice(separator + 1))];
    }),
  );
}

export function sessionCookie(value, { secure = false, maxAge = 60 * 60 * 12 } = {}) {
  const parts = [
    `sid=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function safeTokenEquals(expected, received) {
  const first = Buffer.from(String(expected || ''));
  const second = Buffer.from(String(received || ''));
  return first.length === second.length && timingSafeEqual(first, second);
}
