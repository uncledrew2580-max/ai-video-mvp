// P14-C1B0 — new-machine restart / persistence smoke support (offline nonpaid).
//
// Verifies the restart-smoke harness: the workflow new_machine_restart scope (gate enforced,
// NO bypass, NO generation), the in-memory test keypair reused across the restart (private key
// never on disk/logs/artifact), unlicensed-block + activation + restart-persistence coverage,
// and that image/video smokes are unaffected.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'win', 'new-machine-restart-smoke.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows-ui-smoke-image-only.yml');
const readSrc = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('C1B0: workflow adds new_machine_restart (gate enforced, no bypass, runs the restart script)', () => {
  const yml = readSrc(WORKFLOW);
  assert.ok(/options:[\s\S]{0,160}- new_machine_restart/.test(yml), 'smoke_scope includes new_machine_restart');
  assert.ok(/if: \$\{\{ inputs\.smoke_scope == 'new_machine_restart' \}\}[\s\S]{0,300}new-machine-restart-smoke\.mjs/.test(yml), 'a dedicated step runs the restart smoke');
  // the restart step enforces required + does NOT bypass.
  const step = yml.slice(yml.indexOf('Run new-machine restart smoke'), yml.indexOf('new-machine-restart-smoke.mjs') + 40);
  assert.ok(/AI_VIDEO_LICENSE_REQUIRED: '1'/.test(step) && !/AI_VIDEO_LICENSE_BYPASS/.test(step), 'required on, no bypass');
  // it runs under the image_only safety scope (no generation) + upload includes its report.
  assert.ok(/inputs\.smoke_scope == 'new_machine_restart'\) && 'image_only'/.test(yml), 'new_machine_restart → image_only scope');
  assert.ok(/new-machine-restart-report\.json/.test(yml), 'upload includes the restart report');
});

test('C1B0: image/video + license_gate steps are skipped for new_machine_restart (no regression)', () => {
  const yml = readSrc(WORKFLOW);
  assert.ok(/if: \$\{\{ inputs\.smoke_scope != 'license_gate' && inputs\.smoke_scope != 'new_machine_restart' \}\}/.test(yml),
    'image/video step skipped for license_gate AND new_machine_restart');
  // image/video bypass is unchanged (B8AI/B8AP green).
  assert.ok(/AI_VIDEO_LICENSE_BYPASS: '1'[\s\S]{0,120}ui-smoke-image-only\.mjs/.test(yml), 'image/video keeps its bypass');
});

test('C1B0: the restart script enforces the gate in-process (required on, bypass deleted, test pub key)', () => {
  const s = readSrc(SCRIPT);
  assert.ok(/process\.env\.AI_VIDEO_LICENSE_REQUIRED = '1'/.test(s), 'forces required');
  assert.ok(/delete process\.env\.AI_VIDEO_LICENSE_BYPASS/.test(s), 'deletes bypass');
  assert.ok(/process\.env\.AI_VIDEO_LICENSE_PUBLIC_KEY = TEST_PUBLIC_PEM/.test(s), 'hands the TEST public key to the app');
});

test('C1B0: ONE in-memory test keypair reused across restart; private key NEVER written to disk', () => {
  const s = readSrc(SCRIPT);
  assert.ok((s.match(/generateKeyPairSync\('ed25519'\)/g) || []).length >= 1, 'generates the keypair');
  // the same TEST_PRIV is used in both launches (re-verify the persisted license) — generated once at module scope.
  assert.ok(/const \{ publicKey: TEST_PUB_OBJ, privateKey: TEST_PRIV \} = crypto\.generateKeyPairSync/.test(s), 'keypair generated once at module scope');
  assert.ok(!/writeFileSync\([^)]*TEST_PRIV/.test(s) && !/writeFileSync\([^)]*WRONG_PRIV/.test(s), 'private key never writeFileSync');
  assert.ok(!/license-authority/.test(s), 'no production private key / authority path used');
});

test('C1B0: the restart script performs a real stop → relaunch → persistence cycle', () => {
  const s = readSrc(SCRIPT);
  assert.ok(/async function launchApp\(\)/.test(s) && /async function stopApp\(/.test(s), 'has launch + stop helpers');
  // two launches: l1 then l2 after stopApp; persistence checked WITHOUT re-activation.
  assert.ok(/const l1 = await launchApp\(\)|l1 = await launchApp\(\)/.test(s) && /l2 = await launchApp\(\)/.test(s), 'launches twice');
  assert.ok(/report\.app_stopped = await stopApp\(/.test(s), 'stops the app between launches');
  assert.ok(/license_status_valid_after_restart[\s\S]{0,120}getJson\('\/license\/status'\)/.test(s) || /stA = await getJson\('\/license\/status'\)/.test(s), 're-reads /license/status after restart');
  // after restart there is NO new /activate before re-checking validity (persistence, not re-activation).
  const afterIdx = s.indexOf('Relaunch #2');
  const verdictIdx = s.indexOf('verdict');
  const between = s.slice(afterIdx, verdictIdx);
  assert.ok(!/postForm\('\/activate'/.test(between), 'no re-activation after restart (true persistence)');
});

test('C1B0: report exposes the full clean→unlicensed→activate→restart→persist chain', () => {
  const s = readSrc(SCRIPT);
  for (const f of ['clean_runner', 'app_started_first_launch', 'healthz_ok', 'activation_page_visible', 'unlicensed_workbench_blocked', 'unlicensed_config_save_blocked', 'unlicensed_submit_product_blocked', 'test_license_issued', 'test_license_activated', 'license_file_exists', 'license_status_valid_before_restart', 'app_stopped', 'app_restarted', 'license_status_valid_after_restart', 'workbench_allowed_after_restart', 'config_save_allowed_after_restart', 'license_present', 'license_valid', 'machine_id_hash_prefix', 'mismatch_rejected', 'expired_rejected', 'tampered_rejected', 'wrong_key_rejected', 'api_key_cannot_bypass_license']) {
    assert.ok(s.includes(`${f}:`), `report must include ${f}`);
  }
});

test('C1B0: the restart smoke makes NO generation calls (model/merge/export stay false)', () => {
  const s = readSrc(SCRIPT);
  assert.ok(/model_called: false/.test(s) && /final_merge_called: false/.test(s) && /export_called: false/.test(s), 'generation flags default false');
  assert.ok(!/veo\/generate|\/v1\/veo|nanobanana|gemini.*image|final-merge|export-project|allow_video_generation/i.test(s), 'no model/merge/export endpoints');
  const posts = [...s.matchAll(/post(?:Form|Json)\('([^']+)'/g)].map((m) => m[1]);
  for (const p of posts) assert.ok(['/submit-product', '/config-save', '/activate'].includes(p), `unexpected POST ${p}`);
});

test('C1B0: the restart smoke is leak-safe (redaction + scan + fail-on-leak) + reject coverage', () => {
  const s = readSrc(SCRIPT);
  assert.ok(/function leakScan\(\)/.test(s) && /private_key_leaked|activation_code_leaked|api_key_leaked/.test(s), 'has a leak scan');
  assert.ok(/function redactString/.test(s) && /REDACTED_PEM|REDACTED_LICENSE_CODE|REDACTED_KEY/.test(s), 'redacts PEM / license code / keys');
  assert.ok(/if \(leaked\) return fail\('secret_leak_detected'/.test(s), 'a leak fails the run');
  assert.ok(/device_id: 'WRONG-DEVICE-ID'/.test(s) && /expires_at: '2020-01-01'/.test(s) && /\.slice\(0, -6\) \+ 'AAAAAA'/.test(s) && /issueLicense\([^)]*WRONG_PRIV\)/.test(s), 'mismatch/expired/tampered/wrong-key reject cases');
});

test('C1B0: Ed25519 AIV1 sign/verify the restart harness relies on round-trips', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const issue = (o, k) => { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); const sig = crypto.sign(null, Buffer.from(p), k).toString('base64url'); return `AIV1.${p}.${sig}`; };
  const code = issue({ app_id: 'ai-video-mvp', device_id: 'DEV', expires_at: '2099-01-01' }, privateKey);
  const parts = code.split('.');
  assert.ok(crypto.verify(null, Buffer.from(parts[1]), pub, Buffer.from(parts[2], 'base64url')), 'valid signature verifies (persistence re-verify path)');
});
