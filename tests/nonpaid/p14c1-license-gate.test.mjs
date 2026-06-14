// P14-C1 — Windows license activation + IP protection (offline nonpaid).
//
// Verifies the license GATE (no unlicensed access to the workbench / API-key save /
// workflow), the Ed25519 trust model (public key in client, NEVER a private key), machine-id
// binding (copy-pack protection), expiry, redaction, and that the image/video smokes stay
// green via the bypass. Crypto round-trips use a GENERATED test keypair (the real private key
// is offline + git-ignored), so these run anywhere.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVE = path.join(ROOT, '版本测试', 'serve-review-assets.mjs');
const LAUNCHER = path.join(ROOT, 'client', 'launcher.mjs');
const UI_SMOKE = path.join(ROOT, 'scripts', 'win', 'ui-smoke-image-only.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows-ui-smoke-image-only.yml');
const ISSUE_TOOL = path.join(ROOT, 'tools', 'issue-license.mjs');
const readSrc = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// ── Ed25519 round-trip mirroring the serve's verifySignedLicenseCode (AIV1.payload.sig) ──
const b64url = (s) => Buffer.from(s).toString('base64url');
function issue(payloadObj, priv) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.sign(null, Buffer.from(payload), priv).toString('base64url');
  return `AIV1.${payload}.${sig}`;
}
function verify(code, expectedDeviceId, pubPem, appId = 'ai-video-mvp') {
  const parts = String(code || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'AIV1') throw new Error('激活码格式不正确');
  let payload; try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new Error('激活码内容无法解析'); }
  const ok = crypto.verify(null, Buffer.from(parts[1]), pubPem, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('激活码签名无效');
  if (String(payload.app_id || '') !== appId) throw new Error('激活码不适用于当前应用版本');
  if (String(payload.device_id || '').toUpperCase() !== String(expectedDeviceId || '').toUpperCase()) throw new Error('激活码与当前设备不匹配');
  if (payload.expires_at && new Date(payload.expires_at).getTime() < Date.now()) throw new Error('激活码已过期');
  return payload;
}

// ── Gate placement: unlicensed → no workbench / no API-key save / no workflow ──

test('C1: the license gate blocks every protected route BEFORE the workbench/config/workflow', () => {
  const s = readSrc(SERVE);
  const gate = s.indexOf('const licenseStatus = getLicenseStatus();');
  assert.ok(gate > 0, 'the request handler has a license gate');
  assert.ok(/if \(!licenseStatus\.ok\) \{[\s\S]{0,200}renderActivationPage\(licenseStatus\)/.test(s), 'gate returns the activation page when not ok');
  // protected route HANDLERS (not client-side fetch strings) must come AFTER the gate.
  const handlers = {
    "/ (workbench)": /if \(req\.url === '\/' \|\| req\.url === ''\)/,
    "/new-project": /req\.url\.startsWith\('\/new-project'\)/,
    "POST /submit-product": /req\.method === 'POST' && req\.url === '\/submit-product'/,
    "POST /config-save": /req\.method === 'POST' && req\.url === '\/config-save'/,
  };
  for (const [name, re] of Object.entries(handlers)) {
    const idx = s.search(re);
    assert.ok(idx > gate, `protected handler ${name} must be gated (after the license check)`);
  }
});

test('C1: activation / license-status / health endpoints are reachable WITHOUT a license (before the gate)', () => {
  const s = readSrc(SERVE);
  const gate = s.indexOf('const licenseStatus = getLicenseStatus();');
  for (const open of ["req.url === '/license/status'", "req.url === '/activate' || req.url === '/activate/'", "req.url === '/healthz'"]) {
    const idx = s.indexOf(open);
    assert.ok(idx > 0 && idx < gate, `${open} must be served before the gate`);
  }
});

test('C1: API key present does NOT bypass the gate — the gate precedes config + saved-key use', () => {
  const s = readSrc(SERVE);
  const gate = s.indexOf('const licenseStatus = getLicenseStatus();');
  // the /config-save POST HANDLER (not the client-side fetch string) is behind the gate.
  assert.ok(s.search(/req\.method === 'POST' && req\.url === '\/config-save'/) > gate, 'config-save POST handler gated (no API-key save while unlicensed)');
});

// ── Enforcement enablement (env flag) ──

test('C1: getLicenseStatus is forced ON by AI_VIDEO_LICENSE_REQUIRED=1 (env), else config-driven', () => {
  const s = readSrc(SERVE);
  assert.ok(/const required = process\.env\.AI_VIDEO_LICENSE_REQUIRED === '1' \|\| Boolean\(cfg\.license\?\.required\)/.test(s),
    'required honors the env flag + config');
  assert.ok(/process\.env\.AI_VIDEO_LICENSE_BYPASS === '1'/.test(s), 'a dev/smoke bypass exists');
  // default config keeps the gate OFF for dev (env/dist turns it on).
  assert.ok(/license: \{[\s\S]{0,80}required: false/.test(s), 'config default required:false (dev open; packaged enforces via env)');
});

test('C1: the packaged launcher forces the gate ON (dist) and passes bypass/test-key through', () => {
  const l = readSrc(LAUNCHER);
  assert.ok(/AI_VIDEO_LICENSE_REQUIRED: process\.env\.AI_VIDEO_LICENSE_REQUIRED \|\| \(_IS_DIST \? '1' : ''\)/.test(l),
    'launcher sets LICENSE_REQUIRED=1 in dist');
  assert.ok(/\.\.\.process\.env/.test(l), 'serve child inherits process.env (BYPASS / PUBLIC_KEY pass through)');
});

// ── Ed25519 trust model + machine-id binding + expiry (behavioral) ──

test('C1: a valid signed license for THIS device activates', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const code = issue({ app_id: 'ai-video-mvp', device_id: 'DEVICE-A', plan: 'pro', expires_at: '2099-01-01' }, privateKey);
  const payload = verify(code, 'DEVICE-A', pub);
  assert.equal(payload.plan, 'pro');
});

test('C1: machine-id mismatch (copy to another machine) is REJECTED', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const code = issue({ app_id: 'ai-video-mvp', device_id: 'DEVICE-A', expires_at: '2099-01-01' }, privateKey);
  assert.throws(() => verify(code, 'DEVICE-B', pub), /设备不匹配/);
});

test('C1: an expired license is REJECTED', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const code = issue({ app_id: 'ai-video-mvp', device_id: 'DEVICE-A', expires_at: '2020-01-01' }, privateKey);
  assert.throws(() => verify(code, 'DEVICE-A', pub), /已过期/);
});

test('C1: a tampered / corrupt / wrong-key license is REJECTED', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const code = issue({ app_id: 'ai-video-mvp', device_id: 'DEVICE-A', expires_at: '2099-01-01' }, privateKey);
  assert.throws(() => verify(code.slice(0, -6) + 'AAAAAA', 'DEVICE-A', pub), /签名无效/);
  assert.throws(() => verify('not-a-code', 'DEVICE-A', pub), /格式不正确/);
  // signed by a DIFFERENT key → rejected against our public key.
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const forged = issue({ app_id: 'ai-video-mvp', device_id: 'DEVICE-A', expires_at: '2099-01-01' }, other);
  assert.throws(() => verify(forged, 'DEVICE-A', pub), /签名无效/);
});

test('C1: the serve verify uses Ed25519 (crypto.verify(null,...)), device-match + expiry checks', () => {
  const s = readSrc(SERVE);
  assert.ok(/crypto\.verify\(\s*null,/.test(s), 'Ed25519 verify (null algorithm)');
  assert.ok(/激活码与当前设备不匹配/.test(s), 'device-match check (copy-pack)');
  assert.ok(/激活码已过期/.test(s), 'expiry check');
  assert.ok(/激活码签名无效/.test(s) && /激活码格式不正确/.test(s), 'signature + format checks with Chinese errors');
});

// ── No private key in the client; offline signer holds it ──

test('C1: the CLIENT embeds ONLY a public key — no private key anywhere in the shipped serve', () => {
  const s = readSrc(SERVE);
  assert.equal((s.match(/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/g) || []).length, 0, 'no private key literal in serve');
  assert.ok(/BEGIN PUBLIC KEY/.test(s), 'serve embeds the public key for verification');
  // the offline signer reads the private key from a git-ignored path (not bundled).
  const tool = readSrc(ISSUE_TOOL);
  assert.ok(/license-authority/.test(tool) && /private/.test(tool), 'issuer signs offline with a license-authority private key');
  const gi = readSrc(path.join(ROOT, '.gitignore'));
  assert.ok(/\*\.pem/.test(gi) && /license-authority/.test(gi), 'private key path is git-ignored');
});

// ── Diagnostics / logs redaction ──

test('C1: smoke license diagnostics are redacted — no activation code / device raw / API key', () => {
  const s = readSrc(UI_SMOKE);
  const fn = s.slice(s.indexOf('async function collectLicenseDiagnostics'), s.indexOf('function videoCacheDir'));
  for (const f of ['license_required', 'license_present', 'license_valid', 'license_error_code', 'machine_id_hash_prefix', 'license_plan', 'license_expires_at', 'license_bypass']) {
    assert.ok(s.includes(`${f}:`), `report must init ${f}`);
  }
  // only a HASH PREFIX of the device id, never the full id / code / key.
  assert.ok(/machine_id_hash_prefix = st\.device_id \? String\(st\.device_id\)\.slice\(0, 8\)/.test(fn), 'only an 8-char device-hash prefix');
  assert.ok(!/license_code|activation_code|private/i.test(fn), 'never the activation code / private key');
  assert.ok(!/api_key|Authorization|bearer/i.test(fn), 'never the API key / auth header');
  // license file is presence-only (existsSync), never read/emitted.
  assert.ok(/license_present = fs\.existsSync/.test(fn) && !/readFileSync/.test(fn), 'license file is presence-only');
});

test('C1: the serve never logs the full activation code / license record', () => {
  const s = readSrc(SERVE);
  // no console.log of license_code or the raw activation input.
  assert.ok(!/console\.log\([^)]*license_code/i.test(s), 'never logs license_code');
  assert.ok(!/console\.log\([^)]*licenseCode/i.test(s), 'never logs the activation code');
});

// ── Existing capabilities preserved (image-only + minimal_video safety) ──

test('C1: image/video smokes bypass the gate (workflow) so B8AI/B8AP stay green', () => {
  const yml = readSrc(WORKFLOW);
  assert.ok(/AI_VIDEO_LICENSE_BYPASS: '1'/.test(yml), 'the smoke step bypasses the gate');
  // the gate smoke (C1A) will run WITHOUT this; image_only/minimal_video defaults unchanged.
  assert.ok(/REAL_SMOKE_SCOPE: \$\{\{ inputs\.smoke_scope \|\| 'image_only' \}\}/.test(yml), 'image_only default intact');
});

test('C1: minimal_video safety gates + image_only budget are untouched by C1', () => {
  const s = readSrc(UI_SMOKE);
  assert.ok(/: 9 \* 60_000/.test(s), 'image_only 9min budget preserved');
  assert.ok(/final_merge_called === false && report\.export_called === false[\s\S]{0,80}status = 'passed'/.test(s), 'final-merge + export hard gates intact');
  const guard = readSrc(path.join(ROOT, 'scripts', 'win', 'smoke-guard.mjs'));
  assert.ok(/String\(env\.MAX_SHOTS\) === '1'/.test(guard), 'max_shots=1 still enforced');
});
