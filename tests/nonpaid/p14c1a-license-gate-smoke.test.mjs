// P14-C1A0 — license-gate smoke support (offline nonpaid).
//
// Verifies the gate-smoke harness: the workflow license_gate scope (enforced, NO bypass), the
// in-memory test keypair (private key never on disk/logs/artifact), the unlicensed-gate +
// activation + reject-invalid coverage, and that image/video smokes keep their bypass.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'win', 'license-gate-smoke.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows-ui-smoke-image-only.yml');
const readSrc = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('C1A0: workflow adds a license_gate scope that ENFORCES the gate (no bypass)', () => {
  const yml = readSrc(WORKFLOW);
  assert.ok(/options:[\s\S]{0,120}- license_gate/.test(yml), 'smoke_scope includes license_gate');
  // license_gate runs a dedicated step, gate enforced, NO bypass.
  assert.ok(/if: \$\{\{ inputs\.smoke_scope == 'license_gate' \}\}[\s\S]{0,300}license-gate-smoke\.mjs/.test(yml), 'a license_gate step runs the gate-smoke script');
  assert.ok(/AI_VIDEO_LICENSE_REQUIRED: '1'/.test(yml), 'gate step sets LICENSE_REQUIRED=1');
  // the license_gate step does NOT set AI_VIDEO_LICENSE_BYPASS.
  const gateStep = yml.slice(yml.indexOf("Run license-gate smoke"), yml.indexOf('license-gate-smoke.mjs') + 40);
  assert.ok(!/AI_VIDEO_LICENSE_BYPASS/.test(gateStep), 'license_gate step must NOT bypass');
});

test('C1A0: image/video smokes keep their bypass + license_gate maps to the image_only safety scope', () => {
  const yml = readSrc(WORKFLOW);
  // image/video step still bypasses (B8AI/B8AP unaffected) and is skipped for the gate scopes.
  assert.ok(/if: \$\{\{ inputs\.smoke_scope != 'license_gate'[\s\S]{0,80}\}\}[\s\S]{0,900}AI_VIDEO_LICENSE_BYPASS: '1'[\s\S]{0,120}ui-smoke-image-only\.mjs/.test(yml),
    'image/video step bypasses + is skipped for the gate scopes');
  // license_gate runs under image_only REAL_SMOKE_SCOPE so the security gate + guard pass.
  assert.ok(/REAL_SMOKE_SCOPE: \$\{\{[\s\S]{0,120}inputs\.smoke_scope == 'license_gate'[\s\S]{0,80}'image_only'/.test(yml), 'license_gate → image_only scope');
});

test('C1A0: the gate-smoke script enforces the gate in-process (required on, bypass deleted, test pub key)', () => {
  const s = readSrc(SCRIPT);
  assert.ok(/process\.env\.AI_VIDEO_LICENSE_REQUIRED = '1'/.test(s), 'forces required');
  assert.ok(/delete process\.env\.AI_VIDEO_LICENSE_BYPASS/.test(s), 'deletes bypass');
  assert.ok(/process\.env\.AI_VIDEO_LICENSE_PUBLIC_KEY = TEST_PUBLIC_PEM/.test(s), 'hands the TEST public key to the app');
});

test('C1A0: the TEST keypair is in-memory — the private key is NEVER written to disk', () => {
  const s = readSrc(SCRIPT);
  assert.ok(/crypto\.generateKeyPairSync\('ed25519'\)/.test(s), 'generates an Ed25519 test keypair in-process');
  // the private key object (TEST_PRIV / WRONG_PRIV) is never written to a file.
  assert.ok(!/writeFileSync\([^)]*TEST_PRIV/.test(s) && !/writeFileSync\([^)]*WRONG_PRIV/.test(s), 'private key never writeFileSync');
  assert.ok(!/export\(\{[^}]*pkcs8[\s\S]{0,60}writeFileSync/.test(s), 'private PEM never persisted');
  // no production private key path is referenced.
  assert.ok(!/license-authority/.test(s), 'no production private key / authority path used');
});

test('C1A0: the gate-smoke covers unlicensed-block + activation + all reject-invalid cases', () => {
  const s = readSrc(SCRIPT);
  for (const f of ['unlicensed_workbench_blocked', 'unlicensed_new_project_blocked', 'unlicensed_submit_product_blocked', 'unlicensed_config_save_blocked', 'healthz_ok', 'license_status_unlicensed_ok', 'test_license_activated', 'license_status_valid', 'activated_workbench_allowed', 'mismatch_rejected', 'expired_rejected', 'tampered_rejected', 'wrong_key_rejected', 'api_key_cannot_bypass_license', 'machine_id_hash_prefix']) {
    assert.ok(s.includes(`${f}:`), `report must include ${f}`);
  }
  // distinguishes the activation page (gate) from the workbench.
  assert.ok(/isActivationPage = \(html\)[\s\S]{0,120}<title>激活[\s\S]{0,80}name="license_code"/.test(s), 'gate detection via the activation page markers');
  // reject cases use device-mismatch / past-expiry / tampered-sig / wrong-key.
  assert.ok(/device_id: 'WRONG-DEVICE-ID'/.test(s), 'machine-mismatch case');
  assert.ok(/expires_at: '2020-01-01'/.test(s), 'expired case');
  assert.ok(/\.slice\(0, -6\) \+ 'AAAAAA'/.test(s), 'tampered-signature case');
  assert.ok(/issueLicense\([^)]*WRONG_PRIV\)/.test(s), 'wrong-key case');
});

test('C1A0: the gate-smoke makes NO generation calls (no Veo/Nano/video/final/export)', () => {
  const s = readSrc(SCRIPT);
  // it only drives the gate + activation; it must not enable or call generation.
  assert.ok(!/DISABLE_VIDEO_GENERATION = 'false'|allow_video_generation|ALLOW_VIDEO/.test(s), 'never enables video');
  assert.ok(!/veo\/generate|\/v1\/veo|nanobanana|gemini.*image|final-merge|export-project/i.test(s), 'no model/merge/export endpoints');
  // the only POSTs are /config-save + /submit-product (to assert the GATE blocks them) + /activate.
  const posts = [...s.matchAll(/post(?:Form|Json)\('([^']+)'/g)].map((m) => m[1]);
  for (const p of posts) assert.ok(['/submit-product', '/config-save', '/activate'].includes(p), `unexpected POST ${p}`);
});

test('C1A0: the gate-smoke is leak-safe — redaction + a scan for key/code/private-key', () => {
  const s = readSrc(SCRIPT);
  assert.ok(/function leakScan\(\)/.test(s) && /private_key_leaked|activation_code_leaked|api_key_leaked/.test(s), 'has a leak scan');
  assert.ok(/function redactString/.test(s) && /REDACTED_PEM|REDACTED_LICENSE_CODE|REDACTED_KEY/.test(s), 'redacts PEM / license code / keys');
  // a detected leak fails the run.
  assert.ok(/if \(leaked\) return fail\('secret_leak_detected'/.test(s), 'a leak fails the run');
  assert.ok(/license_private_key_in_artifact/.test(s), 'scans the artifact for a private key');
});

test('C1A0: the Ed25519 AIV1 sign/verify the script relies on round-trips correctly', () => {
  // mirror issueLicense + the serve verify to prove the harness logic is sound.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const issue = (o, k) => { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); const sig = crypto.sign(null, Buffer.from(p), k).toString('base64url'); return `AIV1.${p}.${sig}`; };
  const code = issue({ app_id: 'ai-video-mvp', device_id: 'DEV', expires_at: '2099-01-01' }, privateKey);
  const parts = code.split('.');
  assert.equal(parts.length, 3); assert.equal(parts[0], 'AIV1');
  assert.ok(crypto.verify(null, Buffer.from(parts[1]), pub, Buffer.from(parts[2], 'base64url')), 'valid signature verifies');
  const wrong = crypto.generateKeyPairSync('ed25519').privateKey;
  const forged = issue({ app_id: 'ai-video-mvp', device_id: 'DEV', expires_at: '2099-01-01' }, wrong);
  assert.ok(!crypto.verify(null, Buffer.from(forged.split('.')[1]), pub, Buffer.from(forged.split('.')[2], 'base64url')), 'wrong-key signature rejected');
});
