import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('worker ignores API, cross-origin assets and POST requests', () => {
  const handlers = {};
  const origin = 'https://example.test';
  runInNewContext(readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8'), {
    self: { location: { origin }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    URL, CACHE: 'ryadom-test', BASE: '/', FILES: ['/index.html', '/assets/app.js'],
    caches: { open: async () => ({ match: async () => 'offline shell' }) },
  });
  const respond = (url, method = 'GET', mode = 'navigate') => {
    let response;
    handlers.fetch({ request: { url, method, mode }, respondWith: promise => { response = promise; } });
    return response;
  };
  assert.equal(respond(`${origin}/api/v1/places`), undefined);
  assert.equal(respond(`${origin}/`, 'POST'), undefined);
  assert.equal(respond('https://other.test/assets/app.js'), undefined);
  assert.equal(respond(`${origin}/missing.js`), undefined);
  return respond(`${origin}/`).then(response => assert.equal(response, 'offline shell'));
});

test('worker serves the shell under a GitHub Pages subpath', () => {
  const handlers = {};
  const origin = 'https://papagop2.github.io';
  runInNewContext(readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8'), {
    self: { location: { origin }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    URL, CACHE: 'ryadom-test', BASE: '/ryadom/', FILES: ['/ryadom/index.html', '/ryadom/assets/app.js'],
    caches: { open: async () => ({ match: async () => 'offline shell' }) },
  });
  const respond = (url, method = 'GET', mode = 'navigate') => {
    let response;
    handlers.fetch({ request: { url, method, mode }, respondWith: promise => { response = promise; } });
    return response;
  };
  assert.equal(respond(`${origin}/ryadom/api/v1/places`), undefined);
  assert.equal(respond(`${origin}/ryadom/`, 'POST'), undefined);
  assert.equal(respond(`${origin}/other/`), undefined);
  return respond(`${origin}/ryadom/`).then(response => assert.equal(response, 'offline shell'));
});
