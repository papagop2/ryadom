// Генерирует пару VAPID для Web Push и печатает строки для secrets/rjadom-host.env.
// Приватный ключ не коммитить: он должен жить только в secrets и окружении службы.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
const der = privateKey.export({ format: 'der', type: 'pkcs8' });
console.log(`VAPID_PUBLIC_KEY=${raw.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${der.toString('base64')}`);
console.log('VAPID_SUBJECT=mailto:admin@example.com');
