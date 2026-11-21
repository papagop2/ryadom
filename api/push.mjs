// Web Push (RFC 8291 / aes128gcm) без внешней библиотеки.
// Ключи VAPID читаются из окружения; приватный ключ в репозиторий не попадает.
import {
  createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey,
  randomBytes, sign,
} from 'node:crypto';

const b64url = (value) => Buffer.from(value).toString('base64url');
const decodeKey = (value) => Buffer.from(String(value || ''), 'base64url');
const isConfigured = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

let cached = null;
function vapid() {
  if (cached) return cached;
  if (!isConfigured()) return null;
  const privateKey = createPrivateKey({
    key: Buffer.from(process.env.VAPID_PRIVATE_KEY, 'base64'),
    format: 'der', type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), decodeKey(jwk.x), decodeKey(jwk.y)]);
  cached = {
    privateKey,
    publicKey: raw.toString('base64url'),
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  };
  return cached;
}

function hkdfExpand(prk, info, length) {
  let previous = Buffer.alloc(0);
  let output = Buffer.alloc(0);
  for (let counter = 1; output.length < length; counter += 1) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, length);
}

function vapidHeaders(endpoint) {
  const config = vapid();
  if (!config) return null;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: config.subject,
  }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: config.privateKey, dsaEncoding: 'ieee-p1363',
  });
  return {
    Authorization: `vapid t=${header}.${claims}.${b64url(signature)}, k=${config.publicKey}`,
  };
}

// Собирает зашифрованное тело и заголовки запроса. Вынесено отдельно, чтобы
// проверять протокол тестом без обращения к внешнему push-сервису.
export function buildPushRequest(subscription, payload, { ttl = 3600 } = {}) {
  if (!isConfigured()) throw Object.assign(new Error('Push не настроен'), { code: 'push_not_configured' });
  const endpoint = String(subscription.endpoint || '');
  if (!/^https:\/\//i.test(endpoint)) throw Object.assign(new Error('Некорректный endpoint'), { code: 'invalid_endpoint' });
  const uaPublic = decodeKey(subscription.p256dh);
  const authSecret = decodeKey(subscription.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) {
    throw Object.assign(new Error('Некорректный ключ подписки'), { code: 'invalid_subscription' });
  }

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const asPublic = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdfExpand(createHmac('sha256', authSecret).update(shared).digest(), keyInfo, 32);
  const salt = randomBytes(16);
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const record = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);
  const body = Buffer.concat([header, encrypted]);
  const headers = {
    TTL: String(ttl),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    ...vapidHeaders(endpoint),
  };
  return { endpoint, headers, body, asPublic };
}

export function pushEnabled() {
  return isConfigured();
}

export function pushPublicKey() {
  return vapid()?.publicKey ?? null;
}

export async function sendPush(subscription, payload, options = {}) {
  if (!isConfigured()) return { ok: false, status: 0, error: 'push_not_configured' };
  let request;
  try { request = buildPushRequest(subscription, payload, options); }
  catch (error) { return { ok: false, status: 0, error: error.code || error.message }; }
  try {
    const response = await fetch(request.endpoint, {
      method: 'POST', headers: request.headers, body: request.body,
      signal: AbortSignal.timeout(8000),
    });
    const text = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 300);
    return { ok: response.ok, status: response.status, error: text || null };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}
