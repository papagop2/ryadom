// Проверка формата Web Push без внешнего push-сервиса: шифрование и VAPID.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createECDH, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { buildPushRequest, pushEnabled, pushPublicKey } from '../api/push.mjs';

function expand(prk, info, length) {
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

test('Web Push: тело расшифровывается ключом устройства', (t) => {
  if (!pushEnabled()) return t.skip('VAPID не настроен');
  const publicKey = Buffer.from(pushPublicKey(), 'base64url');
  assert.equal(publicKey.length, 65);
  assert.equal(publicKey[0], 4);

  const device = createECDH('prime256v1');
  device.generateKeys();
  const authSecret = randomBytes(16);
  const request = buildPushRequest({
    endpoint: 'https://push.example.test/subscription',
    p256dh: device.getPublicKey().toString('base64url'),
    auth: authSecret.toString('base64url'),
  }, { title: 'Рядом', body: 'Вас вызвали' });

  const salt = request.body.subarray(0, 16);
  const idLength = request.body[20];
  const asPublic = request.body.subarray(21, 21 + idLength);
  const ciphertext = request.body.subarray(21 + idLength);
  const shared = device.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), device.getPublicKey(), asPublic]);
  const ikm = expand(createHmac('sha256', authSecret).update(shared).digest(), keyInfo, 32);
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2);
  assert.deepEqual(JSON.parse(plain.subarray(0, -1).toString()), { title: 'Рядом', body: 'Вас вызвали' });
  assert.match(request.headers.Authorization, /^vapid t=.+, k=.+$/);
});
