import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const read = file => readFile(resolve(root, file), 'utf8');
const runtime = ['js/config.js', 'js/storage.js', 'js/crypto.js', 'js/auth.js', 'js/cloud.js', 'js/ble.js', 'js/mesh.js', 'js/calls.js', 'js/app.js'];

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

test('BLE bridge wrapper only exposes native packet APIs when the Android bridge is present', async () => {
  const source = await read('js/ble.js');
  const sent = [];
  const packet = { v: 1, id: 'packet-id' };
  const ble = runInNewContext(source + String.fromCharCode(10) + 'ProxiBLE', {
    window: { ProxiTalkNative: {
      getBleStatus: () => JSON.stringify({ available: true, running: true, connectedPeerCount: 1 }),
      startBleDiscovery: () => JSON.stringify({ ok: true }),
      stopBleDiscovery: () => JSON.stringify({ ok: true }),
      setBleIdentity: value => { globalThis.identity = value; },
      setBleRelayEnabled: value => JSON.stringify({ ok: true, relayEnabled: value }),
      acknowledgeBlePacket: value => JSON.stringify({ ok: value === 'received' }),
      sendBlePacket: value => { sent.push(JSON.parse(value)); return JSON.stringify({ ok: true, connectedPeerCount: 1 }); },
      drainBlePackets: () => JSON.stringify([{ v: 1, id: 'received' }]),
    } }, JSON,
  });
  assert.equal(ble.detect(), 'native-discovery');
  assert.equal(ble.getStatus().connectedPeerCount, 1);
  assert.equal(ble.setIdentity('user-id'), true);
  assert.equal(ble.setRelayEnabled(true).relayEnabled, true);
  assert.equal(ble.acknowledgePacket('received').ok, true);
  assert.equal(ble.sendPacket(packet).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), packet);
  assert.equal(ble.drainPackets()[0].id, 'received');
});

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
  const signingPublic = alice.getSigningPublicKey();
  const signedPayload = { id: 'packet-test', recipient: 'bob-test', ciphertext: 'opaque' };
  const signature = await alice.signPayload(signedPayload);
  assert.equal(await alice.verifyPayload(signingPublic, signedPayload, signature), true);
  assert.equal(await alice.verifyPayload(signingPublic, { ...signedPayload, recipient: 'mallory' }, signature), false);
  const blePacket = await alice.signPacket({ v: 1, id: 'packet-id', sender_id: 'alice-test', recipient_id: 'bob-test', ciphertext: { ct: 'opaque' } });
  assert.equal(await alice.verifyPacket(blePacket, signingPublic), true);
  assert.equal(await alice.verifyPacket({ ...blePacket, route_hops: 3 }, signingPublic), true);
  assert.equal(await alice.verifyPacket({ ...blePacket, recipient_id: 'mallory' }, signingPublic), false);
  assert.equal(await bob.verifyPacket(blePacket, bobPublic), false);
  assert.ok(alicePublic.x && bobPublic.x && signingPublic.x);
});

test('WebRTC call signaling contains no plaintext SDP and decrypts only for the intended device', async () => {
  const source = await read('js/calls.js');
  const alice = cryptoHarness(await read('js/crypto.js'));
  const bob = cryptoHarness(await read('js/crypto.js'));
  const alicePublic = await alice.ensureIdentity('alice-caller');
  const bobPublic = await bob.ensureIdentity('bob-recipient');
  const sent = [];
  class PeerConnection {
    addTrack() {}
    async createOffer() { return { type: 'offer', sdp: 'private-sdp-candidate-192.0.2.1' }; }
    async setLocalDescription(value) { this.localDescription = { ...value, toJSON() { return { type: value.type, sdp: value.sdp }; } }; }
    close() {}
  }
  const calls = runInNewContext(source + '\nProxiCalls', {
    crypto: webcrypto,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) } },
    RTCPeerConnection: PeerConnection,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 2, clearTimeout() {},
    console: { warn() {} },
  });
  calls.initialize({ userId: 'alice-caller', profile: { public_key: alicePublic }, crypto: alice,
    cloud: { async receiveCallSignals() { return []; }, async pruneCallSignals() {},
      async sendCallSignal(signal) { sent.push(signal); return { id: 'signal-1' }; } },
    async getContact() { return null; } });
  await calls.start({ userId: 'bob-recipient', publicKey: bobPublic, name: 'Bob' }, 'audio');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'offer');
  const stored = sent[0].ciphertext;
  assert.equal(JSON.stringify(stored).includes('private-sdp-candidate-192.0.2.1'), false);
  assert.equal(Object.hasOwn(stored, 'payload'), false);
  assert.equal(await alice.verifyPacket(stored, alice.getSigningPublicKey()), true);
  const decoded = JSON.parse(await bob.decryptFromMe(stored.ciphertext));
  assert.equal(decoded.payload.description.sdp, 'private-sdp-candidate-192.0.2.1');
  await assert.rejects(alice.decryptFromMe(stored.ciphertext));
  calls.stop();
});

test('directory signing-key migration is additive and owner-scoped', async () => {
  const migration = await read('supabase/migrations/20261118223946_add_directory_signing_keys.sql');
  const cloud = await read('js/cloud.js');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS signing_public_key jsonb/);
  assert.match(migration, /signing_public_key IS NULL OR/);
  assert.match(migration, /NOT \(signing_public_key \? 'd'\)/);
  assert.match(migration, /GRANT UPDATE \(signing_public_key\) ON public\.proxitalk_directory TO authenticated/);
  assert.match(cloud, /public_key,signing_public_key/);
  assert.match(cloud, /updateDirectorySigningKey/);
  assert.match(cloud, /signing_public_key: profile\.signingPublicKey/);
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

test('authentication restores a saved session from persistent browser storage after reload', async () => {
  const source = await read('js/auth.js');
  const persistent = new Map([['proxitalk_auth_session_v1', JSON.stringify({ access_token: 'saved-token', refresh_token: 'saved-refresh', expires_at: Date.now() + 300000 })]]);
  const tabStorage = new Map();
  const storage = map => ({
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  });
  const auth = runInNewContext(source + String.fromCharCode(10) + 'ProxiAuth', {
    window: { ProxiTalkConfig: { supabaseUrl: 'https://example.invalid', publishableKey: 'test-publishable' } },
    localStorage: storage(persistent), sessionStorage: storage(tabStorage),
    crypto: webcrypto, location: { href: 'https://proxitalk.example/', origin: 'https://proxitalk.example', pathname: '/' },
    history: { replaceState() {} }, URL, URLSearchParams, TextEncoder, btoa, fetch: async () => ({
      ok: true, async text() { return JSON.stringify({ id: 'user-1', email: 'person@example.com' }); },
    }),
  });
  const user = await auth.initialize();
  assert.equal(user.id, 'user-1');
  assert.equal(auth.isSignedIn(), true);
  assert.equal(persistent.has('proxitalk_auth_session_v1'), true);
});

test('Google OAuth uses a saved PKCE verifier and the configured app redirect', async () => {
  const source = await read('js/auth.js');
  const local = new Map();
  const storage = {
    getItem: key => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, String(value)),
    removeItem: key => local.delete(key),
  };
  const assigned = [];
  const auth = runInNewContext(source + String.fromCharCode(10) + 'ProxiAuth', {
    window: {
      ProxiTalkConfig: { supabaseUrl: 'https://project.supabase.co', publishableKey: 'test-publishable' },
      location: { assign: value => assigned.push(value) },
    },
    localStorage: storage, sessionStorage: storage, crypto: webcrypto, URL, URLSearchParams, TextEncoder, btoa,
    location: { href: 'https://charlielwanga.github.io/ProxiTalk/', origin: 'https://charlielwanga.github.io', pathname: '/ProxiTalk/' },
    history: { replaceState() {} },
  });
  await auth.signInWithGoogle();
  const authorize = new URL(assigned[0]);
  assert.equal(authorize.origin, 'https://project.supabase.co');
  assert.equal(authorize.pathname, '/auth/v1/authorize');
  assert.equal(authorize.searchParams.get('provider'), 'google');
  assert.equal(authorize.searchParams.get('redirect_to'), 'https://charlielwanga.github.io/ProxiTalk/');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 's256');
  const verifier = JSON.parse(local.get('proxitalk_auth_pkce_verifier')).value;
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
  assert.equal(authorize.searchParams.get('code_challenge'), challenge);

  const callbackAuth = runInNewContext(source + String.fromCharCode(10) + 'ProxiAuth', {
    window: { ProxiTalkConfig: { supabaseUrl: 'https://project.supabase.co', publishableKey: 'test-publishable' } },
    localStorage: storage, sessionStorage: storage, crypto: webcrypto, URL, URLSearchParams, TextEncoder, btoa,
    location: { href: 'https://charlielwanga.github.io/ProxiTalk/?error=access_denied&error_description=Sign-in%20cancelled', origin: 'https://charlielwanga.github.io', pathname: '/ProxiTalk/' },
    history: { replaceState() {} },
  });
  assert.equal(await callbackAuth.initialize(), null);
  assert.equal(callbackAuth.getError(), 'Sign-in cancelled');
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
  assert.match(auth, /signInWithGoogle/);
  assert.match(auth, /auth\/v1\/authorize/);
  assert.match(html, /id="googleSignIn"/);
  assert.match(html, /Continue with Google/);
  assert.match(auth, /grant_type=pkce/);
  assert.match(auth, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(auth, /localStorage\.setItem\(STORAGE_KEY, serialized\)/);
  assert.match(auth, /sessionStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(html, /js\/auth\.js/);
  assert.match(html, /js\/cloud\.js/);
  assert.match(html, /js\/crypto\.js/);
  assert.match(html, /connect-src[^\"]*https:\/\/oxmxffftlpbpbydphhpv\.supabase\.co/);
  assert.match(config, /https:\/\/oxmxffftlpbpbydphhpv\.supabase\.co/);
  assert.match(config, /sb_publishable_/);
  assert.doesNotMatch(config, /sb_secret_/);
  assert.match(html, /Early access: encrypted one-to-one online text and beta one-to-one voice\/video calls/);
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

test('Android BLE GATT carrier only accepts bounded recipient-key-encrypted packet envelopes', async () => {
  const manifest = await read('android/AndroidManifest.xml');
  const service = await read('android/app/src/main/java/com/proxitalk/app/BleMeshService.java');
  const activity = await read('android/app/src/main/java/com/proxitalk/app/MainActivity.java');
  const ble = await read('js/ble.js');
  const html = await read('index.html');
  assert.match(manifest, /android.permission.BLUETOOTH_SCAN/);
  assert.match(manifest, /android.permission.BLUETOOTH_ADVERTISE/);
  assert.match(manifest, /android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE/);
  assert.match(manifest, /android:name="\.BleMeshService"[\s\S]*?android:exported="false"/);
  assert.match(service, /startAdvertising\(\)/);
  assert.match(service, /startScanning\(\)/);
  assert.match(service, /setConnectable\(true\)/);
  assert.match(service, /openGattServer\(\)/);
  assert.match(service, /MAX_PACKET_BYTES = 16 \* 1024/);
  assert.match(service, /FRAME_HEADER_BYTES = 8/);
  assert.match(service, /ECDH-P256\/HKDF-SHA256\/AES-256-GCM/);
  assert.match(service, /route_hops/);
  assert.match(service, /packetStore\.putPacket\(packet, false, address\)/);
  assert.match(service, /packetStore\.pendingForPeer/);
  assert.match(service, /relayEnabled/);
  assert.match(service, /MAX_RELAY_HOPS/);
  const store = await read('android/app/src/main/java/com/proxitalk/app/BlePacketStore.java');
  assert.match(store, /MAX_PACKETS = 256/);
  assert.match(store, /MAX_BYTES = 4L \* 1024L \* 1024L/);
  assert.match(store, /MAX_FORWARD_RECORDS = 2_048/);
  assert.match(store, /CREATE TABLE packets/);
  assert.match(store, /leaseRecipientPackets/);
  assert.match(store, /p\.route_hops<\?/);
  assert.match(service, /senderSigningKey/);
  assert.match(ble, /sendPacket/);
  assert.match(service, /Arrays\.asList\("kty", "crv", "x", "y", "ext", "key_ops"\)/);
  assert.doesNotMatch(service, /ephemeral\.optString\("d"\)/);
  assert.match(activity, /requestOrStartMesh\(\)/);
  assert.match(activity, /sendBlePacket\(String encryptedPacketJson\)/);
  assert.match(activity, /drainBlePackets\(\)/);
  assert.match(ble, /sendBlePacket/);
  assert.match(ble, /drainBlePackets/);
  assert.match(html, /signed, recipient-encrypted packet path/);
  assert.match(html, /3-hop cap/);
  assert.match(html, /signed recipient-decryption acknowledgements/);
  const app = await read('js/app.js');
  assert.match(app, /ProxiCrypto\.signPacket/);
  assert.match(app, /ProxiCrypto\.verifyPacket/);
  assert.match(app, /ProxiCrypto\.decryptFromMe\(packet\.ciphertext\)/);
  assert.match(app, /ble_queued/);
  assert.match(app, /delivered_ack/);
  assert.match(app, /sendBleAcknowledgement/);
  assert.match(app, /ble_delivered/);
  assert.match(app, /expectedRecipient === packet\.sender_id/);
  assert.match(service, /packetStore\.markForwarded/);
  assert.match(service, /setRelayEnabled/);
  assert.match(activity, /setBleRelayEnabled/);
  assert.match(activity, /acknowledgeBlePacket/);
});

test('Android 13 app shell uses a secure asset origin and a narrow PKCE deep link', async () => {
  const activity = await read('android/app/src/main/java/com/proxitalk/app/MainActivity.java');
  const manifest = await read('android/AndroidManifest.xml');
  const auth = await read('js/auth.js');
  const gradle = await read('android/app/build.gradle');
  const workflow = await read('.github/workflows/android-debug-apk.yml');
  assert.match(activity, /WebViewAssetLoader/);
  assert.match(activity, /request\.deny\(\)/);
  assert.match(activity, /APP_ORIGIN\.equals\(request\.getOrigin\(\)\.toString\(\)\)/);
  assert.match(activity, /RESOURCE_AUDIO_CAPTURE/);
  assert.match(activity, /RESOURCE_VIDEO_CAPTURE/);
  assert.doesNotMatch(activity, /sendPacket/);
  assert.match(activity, /setAllowFileAccessFromFileURLs\(false\)/);
  assert.match(activity, /setAllowUniversalAccessFromFileURLs\(false\)/);
  assert.match(activity, /code\.length\(\) <= 4096/);
  assert.match(activity, /getAuthRedirectUrl\(\)/);
  assert.match(activity, /getQueryParameter\("error"\)/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(await read('manifest.json'), /proxitalk-app-icon\.png/);
  assert.match(manifest, /android:scheme="com\.proxitalk\.app" android:host="auth" android:path="\/callback"/);
  assert.match(auth, /com\.proxitalk\.app:\/\/auth\/callback/);
  assert.match(gradle, /targetSdk rootProject\.ext\.targetSdk/);
  assert.match(await read('android/build.gradle'), /versionCode = 3/);
  assert.match(workflow, /java-version: '17'/);
  assert.match(workflow, /gradle-version: '8\.7'/);
  assert.match(workflow, /assembleDebug/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /proxitalk-android-v1\.2\.0-beta1/);
  assert.match(workflow, /retention-days: 30/);
  assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/);
});

test('beta calls keep explicit limits while unsupported features remain disclosed', async () => {
  const html = await read('index.html');
  const app = await read('js/app.js');
  const readme = await read('README.md');
  assert.match(html, /beta one-to-one voice\/video calls/);
  assert.match(html, /No call notifications or emergency calling/);
  assert.match(app, /Encrypted group messaging is not available yet/);
  assert.match(readme, /there is no TURN relay/);
  assert.match(readme, /Do not use it for emergencies/);
});

test('calls encrypt and device-sign signaling, use WebRTC, and keep RLS participant-scoped', async () => {
  const calls = await read('js/calls.js');
  const cloud = await read('js/cloud.js');
  const migration = await read('supabase/migrations/202611200001_add_encrypted_call_signaling.sql');
  const html = await read('index.html');
  const manifest = await read('android/AndroidManifest.xml');
  const activity = await read('android/app/src/main/java/com/proxitalk/app/MainActivity.java');
  assert.match(calls, /new RTCPeerConnection/);
  assert.match(calls, /getUserMedia/);
  assert.match(calls, /crypto\.encryptFor\(targetCall\.contact\.publicKey/);
  assert.match(calls, /crypto\.signPacket/);
  assert.match(calls, /crypto\.verifyPacket/);
  assert.match(calls, /crypto\.decryptFromMe/);
  assert.match(calls, /stun:stun\.l\.google\.com:19302/);
  assert.match(calls, /foreground|visibilityState/);
  assert.match(cloud, /sendCallSignal/);
  assert.match(cloud, /receiveCallSignals/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /call_signals_sender_insert[\s\S]*sender_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /call_signals_participant_read[\s\S]*recipient_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /expires_at <= created_at \+ interval '10 minutes'/);
  assert.match(html, /id="callRemoteVideo"/);
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.permission\.CAMERA/);
  assert.match(activity, /RESOURCE_AUDIO_CAPTURE/);
  assert.match(activity, /RESOURCE_VIDEO_CAPTURE/);
  assert.match(activity, /APP_ORIGIN\.equals\(request\.getOrigin\(\)\.toString\(\)\)/);
  assert.match(activity, /CALL_PERMISSION_REQUEST/);
});

test('static build includes the complete application shell and service worker never caches APIs', async () => {
  for (const file of ['dist/index.html', 'dist/manifest.json', 'dist/sw.js', 'dist/css/style.css', 'dist/js/config.js', 'dist/js/storage.js', 'dist/js/crypto.js', 'dist/js/auth.js', 'dist/js/cloud.js', 'dist/js/ble.js', 'dist/js/mesh.js', 'dist/js/calls.js', 'dist/js/app.js', 'dist/assets/icon.svg', 'dist/assets/proxitalk-app-icon.png', 'dist/assets/proxitalk-app-icon-maskable.png', 'android/app/src/main/assets/www/index.html']) {
    await assert.doesNotReject(access(resolve(root, file)), file);
  }
  const sw = await read('dist/sw.js');
  assert.match(sw, /const CACHE = 'proxitalk-shell-v13'/);
  const assetList = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(assetList, 'service worker should declare its precache list');
  const assets = [...assetList[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  for (const asset of assets) {
    if (asset === './') continue;
    await assert.doesNotReject(access(resolve(root, 'dist', asset.slice(2))), `precache asset ${asset}`);
  }
  assert.match(sw, /if \(request\.method !== 'GET' \|\| new URL\(request\.url\)\.origin !== self\.location\.origin\) return/);
});
