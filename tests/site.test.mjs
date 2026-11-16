import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = file => readFile(resolve(root, file), 'utf8');

test('runtime JavaScript parses', async () => {
  for (const file of ['js/storage.js', 'js/mesh.js', 'js/app.js']) {
    const source = await read(file);
    assert.doesNotThrow(() => new Function(source), file);
  }
});

test('fresh install has no seeded conversations or fake network replies', async () => {
  const app = await read('js/app.js');
  assert.match(app, /Store\.load\('contacts', \[\]\)/);
  assert.match(app, /Store\.load\('chats', \{\}\)/);
  assert.doesNotMatch(app, /SEED_MSGS|simulateIncoming\(|Simulate peer typing/);
  assert.doesNotMatch(app, /Hey! ProxiTalk is working even though MTN internet is down/);
});

test('the browser build does not load a cloud client or demo transports', async () => {
  const html = await read('index.html');
  assert.match(html, /js\/app\.js/);
  assert.doesNotMatch(html, /js\/(cloud|ble|wifi-direct|calls|sms-bridge|crypto)\.js/);
  assert.doesNotMatch(html, /supabase\.co|ProxiTalk without the internet/);
});

test('message composer clearly reports local-only behavior', async () => {
  const app = await read('js/app.js');
  assert.match(app, /Saved on this device only — not sent to the contact/);
  assert.match(app, /not end-to-end encrypted/);
});

test('static build contains only the deployable site assets', async () => {
  for (const file of ['dist/index.html', 'dist/manifest.json', 'dist/sw.js', 'dist/css/style.css', 'dist/js/app.js', 'dist/assets/icon.svg']) {
    await assert.doesNotReject(access(resolve(root, file)), file);
  }
});
