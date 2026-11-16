import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const read = file => readFile(resolve(root, file), 'utf8');
const runtime = ['js/config.js', 'js/storage.js', 'js/crypto.js', 'js/auth.js', 'js/cloud.js', 'js/mesh.js', 'js/app.js'];

test('runtime JavaScript parses', async () => {
  for (const file of runtime) {
    const source = await read(file);
    assert.doesNotThrow(() => new Function(source), file);
  }
});

function cryptoHarness(source) {
  const records = new Map();
  let initialized = false;
  const database = {
    createObjectStore() {},
    close() {},
    transaction() {
      const tx = {
        objectStore() {
          return {
            get(key) {
              const request = {};
              queueMicrotask(() => { request.result = records.get(key) || null; request.onsuccess?.(); });
              return request;
            },
            put(record) {
              records.set(record.userId, record);
              queueMicrotask(() => tx.oncomplete?.());
            },
          };
        },
      };
      return tx;
    },
  };
  const indexedDB = {
    open() {
      const request = { result: database };
      queueMicrotask(() => {
        if (!initialized) { initialized = true; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    },
  };
  return runInNewContext(source + '\nProxiCrypto', {
    crypto: webcrypto, indexedDB, btoa, atob, TextEncoder, TextDecoder,
    console: { warn() {}, error() {} },
  });
}

test('recipient-only encryption and device-local history encryption round-trip', async () => {
  const cryptoSource = await read('js/crypto.js');
  const alice = cryptoHarness(cryptoSource);
  const bob = cryptoHarness(cryptoSource);
  const alicePublic = await alice.ensureIdentity('alice-test');
  const bobPublic = await bob.ensureIdentity('bob-test');
  const secretText = 'private test payload';
  const envelope = await alice.encryptFor(bobPublic, secretText);
  assert.equal(JSON.stringify(envelope).includes(secretText), false);
  assert.equal(await bob.decryptFromMe(envelope), secretText);
  await assert.rejects(alice.decryptFromMe(envelope));
  const localEnvelope = await alice.encryptLocalData({ text: secretText });
  assert.equal(JSON.stringify(localEnvelope).includes(secretText), false);
  assert.equal(JSON.stringify(await alice.decryptLocalData(localEnvelope)), JSON.stringify({ text: secretText }));
  assert.ok(alicePublic.x && bobPublic.x);
});

test('mailbox send accepts UI camelCase and database snake_case contact keys', async () => {
  const source = await read('js/cloud.js');
  const requests = [];
  const ProxiCloud = runInNewContext(source + String.fromCharCode(10) + 'ProxiCloud', {
    window: { ProxiTalkConfig: { supabaseUrl: 'https://example.invalid', publishableKey: 'test-publishable' } },
    ProxiAuth: { async accessToken() { return 'test-access-token'; } },
    ProxiCrypto: { async encryptFor(key, text) { return { recipientX: key.x, text }; } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 201, async text() { return '[{"id":"message-row"}]'; } };
    },
    console: { warn() {} },
  });
  const key = { x: 'public-x' };
  const camelRow = await ProxiCloud.sendEncryptedMessage('sender', { userId: 'recipient-a', publicKey: key }, 'hello');
  const snakeRow = await ProxiCloud.sendEncryptedMessage('sender', { user_id: 'recipient-b', public_key: key }, 'hello');
  assert.equal(camelRow.id, 'message-row');
  assert.equal(snakeRow.id, 'message-row');
  assert.equal(JSON.parse(requests[0].options.body).recipient_id, 'recipient-a');
  assert.equal(JSON.parse(requests[1].options.body).recipient_id, 'recipient-b');
});

test('fresh installs have no seeded conversations or fake network replies', async () => {
  const app = await read('js/app.js');
  assert.match(app, /Store\.load\('contacts', \[\]\)/);
  assert.match(app, /Store\.load\('chats', \{\}\)/);
  assert.doesNotMatch(app, /SEED_MSGS|simulateIncoming\(|Simulate peer typing/);
  assert.doesNotMatch(app, /Hey! ProxiTalk is working even though MTN internet is down/);
});

test('browser connects only through the authenticated Supabase client and limits CSP to required origins', async () => {
  const html = await read('index.html');
  const config = await read('js/config.js');
  const auth = await read('js/auth.js');
  assert.match(auth, /code_challenge_method: 's256'/);
  assert.match(auth, /grant_type=pkce/);
  assert.match(html, /js\/auth\.js/);
  assert.match(html, /js\/cloud\.js/);
  assert.match(html, /js\/crypto\.js/);
  assert.match(html, /connect-src[^\"]*https:\/\/hsgcsyhyzsftinisksty\.supabase\.co/);
  assert.match(config, /sb_publishable_/);
  assert.doesNotMatch(config, /sb_secret_/);
  assert.match(html, /Early access: one-to-one online text is recipient-key encrypted/);
});

test('message transport encrypts before insert and scopes message policies to participants', async () => {
  const cloud = await read('js/cloud.js');
  const crypto = await read('js/crypto.js');
  const app = await read('js/app.js');
  const migration = await read('supabase/migrations/202611160002_create_authenticated_cloud_messaging.sql');
  assert.match(cloud, /ProxiCrypto\.encryptFor\(recipientPublicKey, plaintext\)/);
  assert.match(cloud, /ciphertext,\s*packet_type: 'message'/);
  assert.match(cloud, /if \(!inserted\?\.id\)/);
  assert.match(app, /msg\.cloudId = savedRow\.id/);
  assert.match(app, /msg\.status = 'failed'/);
  assert.match(crypto, /ECDH/);
  assert.match(crypto, /HKDF/);
  assert.match(crypto, /AES-GCM/);
  assert.match(crypto, /indexedDB/);
  assert.match(crypto, /encryptLocalData/);
  assert.match(app, /ProxiCrypto\.encryptLocalData\(snapshot\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /message_sender_insert[\s\S]*sender_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /message_participants_read[\s\S]*sender_id = \(SELECT auth\.uid\(\)\) OR recipient_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /expires_at <= created_at \+ interval '14 days'/);
});

test('Android 13 app shell uses a secure asset origin and a narrow PKCE deep link', async () => {
  const activity = await read('android/app/src/main/java/com/proxitalk/app/MainActivity.java');
  const manifest = await read('android/AndroidManifest.xml');
  const auth = await read('js/auth.js');
  const gradle = await read('android/app/build.gradle');
  const workflow = await read('.github/workflows/android-debug-apk.yml');
  assert.match(activity, /WebViewAssetLoader/);
  assert.match(activity, /request\.deny\(\)/);
  assert.doesNotMatch(activity, /request\.grant|sendPacket/);
  assert.match(activity, /setAllowFileAccessFromFileURLs\(false\)/);
  assert.match(activity, /setAllowUniversalAccessFromFileURLs\(false\)/);
  assert.match(activity, /code\.length\(\) > 4096/);
  assert.match(activity, /getAuthRedirectUrl\(\)/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android:scheme="com\.proxitalk\.app" android:host="auth" android:path="\/callback"/);
  assert.match(auth, /com\.proxitalk\.app:\/\/auth\/callback/);
  assert.match(gradle, /targetSdk rootProject\.ext\.targetSdk/);
  assert.match(workflow, /java-version: '17'/);
  assert.match(workflow, /gradle-version: '8\.7'/);
  assert.match(workflow, /assembleDebug/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(manifest, /RECORD_AUDIO|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/);
});

test('non-messaging features are accurately disclosed as unavailable', async () => {
  const html = await read('index.html');
  const app = await read('js/app.js');
  assert.match(html, /Attachments, groups, calls, and offline mesh are not available/);
  assert.match(html, /SOS unavailable/);
  assert.match(app, /Encrypted group messaging is not available yet/);
  assert.match(app, /Voice calls are not available/);
});

test('static build includes the complete application shell and service worker never caches APIs', async () => {
  for (const file of ['dist/index.html', 'dist/manifest.json', 'dist/sw.js', 'dist/css/style.css', 'dist/js/config.js', 'dist/js/storage.js', 'dist/js/crypto.js', 'dist/js/auth.js', 'dist/js/cloud.js', 'dist/js/mesh.js', 'dist/js/app.js', 'dist/assets/icon.svg', 'android/app/src/main/assets/www/index.html']) {
    await assert.doesNotReject(access(resolve(root, file)), file);
  }
  const sw = await read('dist/sw.js');
  assert.match(sw, /const CACHE = 'proxitalk-shell-v6'/);
  const assetList = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(assetList, 'service worker should declare its precache list');
  const assets = [...assetList[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  for (const asset of assets) {
    if (asset === './') continue;
    await assert.doesNotReject(access(resolve(root, 'dist', asset.slice(2))), `precache asset ${asset}`);
  }
  assert.match(sw, /if \(request\.method !== 'GET' \|\| new URL\(request\.url\)\.origin !== self\.location\.origin\) return/);
});
