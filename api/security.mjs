// Сессии, CSRF и одноразовые коды входа. Секреты не пишутся в журналы.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'rjadom_sid';
export const CSRF_COOKIE = 'rjadom_csrf';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;

let fallbackSecret;
const secret = () => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Без секрета сессии становятся недействительными после перезапуска.
  // Для стенда это допустимо, но факт пишется в журнал один раз.
  if (!fallbackSecret) {
    fallbackSecret = randomBytes(32).toString('hex');
    console.warn('[security] SESSION_SECRET не задан: используется временный секрет процесса');
  }
  return fallbackSecret;
};

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const tokenHash = (token) => createHmac('sha256', secret()).update(token).digest('hex');

export function hashCode(phone, code) {
  return createHmac('sha256', secret()).update(`${phone}:${code}`).digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) result[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function cookie(name, value, { secure, maxAgeSeconds }) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) attributes.push('Secure');
  if (name === SESSION_COOKIE) attributes.push('HttpOnly');
  return attributes.join('; ');
}

export function isSecureRequest(request) {
  const proto = request.headers['x-forwarded-proto'];
  return request.protocol === 'https' || (typeof proto === 'string' && proto.split(',')[0].trim() === 'https');
}

export function setSessionCookies(reply, request, { sid, csrf }) {
  const secure = isSecureRequest(request);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  reply.header('set-cookie', [
    cookie(SESSION_COOKIE, sid, { secure, maxAgeSeconds: maxAge }),
    cookie(CSRF_COOKIE, csrf, { secure, maxAgeSeconds: maxAge }),
  ]);
}

export function clearSessionCookies(reply, request) {
  const secure = isSecureRequest(request);
  reply.header('set-cookie', [
    cookie(SESSION_COOKIE, '', { secure, maxAgeSeconds: 0 }),
    cookie(CSRF_COOKIE, '', { secure, maxAgeSeconds: 0 }),
  ]);
}

// Телефон в формате E.164 (+7XXXXXXXXXX) — единственный идентификатор входа.
export const normalizePhone = (value) => {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9+]/g, '');
  const unified = digits.startsWith('8') && digits.length === 11 ? `+7${digits.slice(1)}`
    : digits.startsWith('7') && digits.length === 11 ? `+${digits}`
      : digits;
  return /^\+7[0-9]{10}$/.test(unified) ? unified : null;
};
