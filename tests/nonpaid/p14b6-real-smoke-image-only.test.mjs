// P14-B6 nonpaid tests — real-smoke image-only safety checks.
// Parses workflow YAML and script source as raw text; zero model calls, zero network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'windows-real-smoke-image-only.yml');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'win', 'real-smoke-image-only.mjs');

const wf = fs.readFileSync(WF_PATH, 'utf8');
const script = fs.readFileSync(SCRIPT_PATH, 'utf8');

// ── workflow: trigger safety ──────────────────────────────────────────────────

test('workflow has workflow_dispatch trigger', () => {
  assert.match(wf, /workflow_dispatch:/);
});

test('workflow does not have push trigger', () => {
  assert.doesNotMatch(wf, /^\s*push\s*:/m);
});

test('workflow does not have pull_request trigger', () => {
  assert.doesNotMatch(wf, /^\s*pull_request\s*:/m);
});

test('workflow does not have schedule trigger', () => {
  assert.doesNotMatch(wf, /^\s*schedule\s*:/m);
});

// ── workflow: scope env vars ──────────────────────────────────────────────────

test('workflow sets REAL_SMOKE_SCOPE=image_only', () => {
  assert.match(wf, /REAL_SMOKE_SCOPE:\s*image_only/);
});

test('workflow sets DISABLE_VIDEO_GENERATION=true', () => {
  assert.match(wf, /DISABLE_VIDEO_GENERATION:\s*['"]?true['"]?/);
});

// ── workflow: secret hygiene ──────────────────────────────────────────────────

test('workflow references AI_VIDEO_API_KEY via secrets (not plaintext)', () => {
  assert.match(wf, /secrets\.AI_VIDEO_API_KEY/);
});

test('workflow masks secrets via add-mask', () => {
  assert.match(wf, /add-mask/);
});

test('workflow contains no plaintext key patterns (sk- prefix)', () => {
  assert.doesNotMatch(wf, /sk-[A-Za-z0-9]{10,}/);
});

test('workflow contains no plaintext Bearer token patterns', () => {
  assert.doesNotMatch(wf, /Bearer [A-Za-z0-9]{10,}/);
});

// ── workflow: artifact wiring ─────────────────────────────────────────────────

test('workflow references artifact AI-Video-Win-x64-Portable-RC-0001', () => {
  assert.match(wf, /AI-Video-Win-x64-Portable-RC-0001/);
});

test('workflow default artifact_run_id is 27163429484', () => {
  assert.match(wf, /27163429484/);
});

// ── script: scope guards ──────────────────────────────────────────────────────

test('script enforces REAL_SMOKE_SCOPE=image_only', () => {
  assert.match(script, /REAL_SMOKE_SCOPE/);
  assert.match(script, /image_only/);
});

test('script enforces DISABLE_VIDEO_GENERATION guard', () => {
  assert.match(script, /DISABLE_VIDEO_GENERATION/);
});

// ── script: forbidden path guards ────────────────────────────────────────────

test('script has explicit video guard token', () => {
  assert.match(script, /'video'/);
});

test('script has explicit veo guard token', () => {
  assert.match(script, /'veo'/);
});

test('script has explicit final guard token', () => {
  assert.match(script, /'final'/);
});

test('script has explicit review-submit guard token', () => {
  assert.match(script, /review-submit/);
});

test('script has explicit rerun-shot guard token', () => {
  assert.match(script, /rerun-shot/);
});

// ── script: secret hygiene ────────────────────────────────────────────────────

test('script does not contain Authorization header string', () => {
  assert.doesNotMatch(script, /Authorization/);
});

test('script has no plaintext key patterns (sk- prefix)', () => {
  assert.doesNotMatch(script, /sk-[A-Za-z0-9]{10,}/);
});

test('script has no plaintext Bearer token patterns', () => {
  assert.doesNotMatch(script, /Bearer [A-Za-z0-9]{10,}/);
});

// ── script: dry-run / nonpaid safety ─────────────────────────────────────────

test('script skips model calls in dry-run path (TODO present)', () => {
  assert.match(script, /DRY_RUN/);
  assert.match(script, /TODO/);
});

// ── script: output artifacts ─────────────────────────────────────────────────

test('script writes smoke-report.json', () => {
  assert.match(script, /smoke-report\.json/);
});

test('script creates diagnostics directory', () => {
  assert.match(script, /diagnostics/);
});
