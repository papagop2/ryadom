import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const folder = new URL('./public/', import.meta.url);
mkdirSync(folder, { recursive: true });
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = -1;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(8 + body.length);
  result.writeUInt32BE(data.length);
  body.copy(result, 4);
  result.writeUInt32BE((~crc) >>> 0, result.length - 4);
  return result;
}

for (const [name, size] of [['192', 192], ['512', 512], ['maskable', 512]]) {
  const stride = 1 + size * 3;
  const pixels = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x / size - .5;
    const dy = y / size - .5;
    const head = Math.hypot(dx, dy + .07);
    const color = head < .059 ? [201, 105, 75] : head < .17 ||
      (dy >= .015 && dy < .27 && Math.abs(dx) < (.27 - dy) * .67) ? [255, 244, 220] : [36, 70, 55];
    pixels.set(color, y * stride + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  writeFileSync(new URL(`icon-${name}.png`, folder), Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
