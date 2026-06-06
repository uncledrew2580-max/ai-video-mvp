/**
 * P12-J1 nonpaid tests — UI-only polish + app-icon source guardrails.
 *
 * This round only refines the visual layer (shared commonCSS tokens/components)
 * and adds local app-icon source assets. These tests LOCK the contracts that the
 * UI polish must NOT touch:
 *   - routes / endpoints unchanged
 *   - product intake form action/method/enctype + field names unchanged
 *   - /review-submit form action/method/hidden fields unchanged
 *   - /review-rerun-shot entry + hidden fields unchanged
 *   - quality-reroll cost-confirm wording ("会消耗一次视频额度") still present
 *   - running dup-prevent wording ("请勿重复提交") still present
 *   - partial_export Chinese warning still present
 *   - app-icon source assets exist and the generator script is syntactically valid
 *
 * Non-paid: pure static reads + node --check. No n8n, no model calls, no packaging.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SERVE_PATH = path.join(ROOT, '版本测试', 'serve-review-assets.mjs');
const SERVE = fs.readFileSync(SERVE_PATH, 'utf8');

test('routes / endpoints are all still present', () => {
  const routes = [
    "req.url === '/review-submit'",
    "req.url === '/review-rerun-shot'",
    "req.url === '/review-rerun-failed'",
    "req.url === '/review-rerun-pending'",
    "req.url === '/review-redo-panel'",
    "req.url === '/review-pause-project'",
    "req.url.startsWith('/review-status')",
  ];
  for (const r of routes) {
    assert.ok(SERVE.includes(r), `missing route handler: ${r}`);
  }
  // Form action endpoints referenced in markup must remain stable.
  const actions = [
    'action="/submit-product"',
    'action="/review-submit"',
    'action="/review-rerun-shot"',
    'action="/review-rerun-failed"',
    'action="/review-rerun-pending"',
    'action="/review-pause-project"',
    'action="/script-shot-save"',
    'action="/concept-select"',
  ];
  for (const a of actions) {
    assert.ok(SERVE.includes(a), `missing form action: ${a}`);
  }
});

test('product intake form contract unchanged (action/method/enctype/fields)', () => {
  assert.ok(
    SERVE.includes('<form id="product-intake-form" method="POST" action="/submit-product" enctype="multipart/form-data">'),
    'product intake form opening tag changed',
  );
  // Field names are the webhook contract — they must not be renamed by UI polish.
  for (const n of ['field-0', 'field-1', 'field-2', 'field-3', 'field-4', 'field-5']) {
    assert.ok(SERVE.includes(`name="${n}"`), `missing intake field: ${n}`);
  }
});

test('/review-submit form method + hidden fields unchanged', () => {
  assert.ok(SERVE.includes('<form method="POST" action="/review-submit">'), 'review-submit form tag changed');
  const hidden = ['review_context_path', 'review_round', 'project_id', 'product_name', 'review_decision'];
  // Scope the assertion to a review-submit form region.
  const idx = SERVE.indexOf('action="/review-submit"');
  const region = SERVE.slice(idx, idx + 1200);
  for (const h of hidden) {
    assert.ok(region.includes(`name="${h}"`), `review-submit missing hidden field: ${h}`);
  }
});

test('/review-rerun-shot entry + hidden fields unchanged', () => {
  assert.ok(SERVE.includes('action="/review-rerun-shot"'), 'review-rerun-shot form missing');
  // The server-side gating branch that only allows rerun for completed/done/failed shots.
  assert.ok(
    SERVE.includes("['completed', 'done', 'failed'].includes(shotStatus)") ||
      SERVE.includes("['completed', 'done', 'failed'].includes(s)"),
    'review-rerun-shot status gating changed',
  );
  const idx = SERVE.indexOf('action="/review-rerun-shot"');
  const region = SERVE.slice(idx, idx + 1600);
  for (const h of ['review_context_path', 'project_id', 'product_name', 'review_round', 'shot_id', 'shot_order', 'cost_confirmed']) {
    assert.ok(region.includes(`name="${h}"`), `review-rerun-shot missing hidden field: ${h}`);
  }
});

test('quality reroll cost-confirmation wording still present', () => {
  assert.ok(SERVE.includes('会消耗一次视频额度'), 'cost-confirm wording removed');
});

test('running dup-prevent wording still present', () => {
  assert.ok(SERVE.includes('请勿重复提交'), 'running dup-prevent wording removed');
});

test('partial_export Chinese warning still present', () => {
  assert.ok(
    SERVE.includes('部分镜头尚未完成，导出的是当前已完成的产物，不含完整成片。'),
    'partial_export warning removed',
  );
  assert.ok(SERVE.includes("'partial_export'"), 'partial_export status literal removed');
});

test('app-icon source assets exist', () => {
  const assets = [
    path.join(ROOT, 'assets', 'app-icon', 'icon-source.svg'),
    path.join(ROOT, 'assets', 'app-icon', 'icon-1024.png'),
    path.join(ROOT, 'scripts', 'generate-app-icon.mjs'),
    path.join(ROOT, 'build', 'icon.icns'),
  ];
  for (const a of assets) {
    assert.ok(fs.existsSync(a), `missing app-icon asset: ${path.relative(ROOT, a)}`);
  }
  // Source SVG must be self-contained (no remote/font refs, no third-party logos).
  const svg = fs.readFileSync(assets[0], 'utf8');
  assert.ok(!/https?:\/\//i.test(svg.replace(/xmlns="http:\/\/www\.w3\.org[^"]*"/g, '')), 'SVG references a remote URL');
  assert.ok(!/@font-face|fonts\.googleapis|\.woff/i.test(svg), 'SVG embeds an online font');
});

test('app-icon generator script is syntactically valid', () => {
  const script = path.join(ROOT, 'scripts', 'generate-app-icon.mjs');
  // node --check throws on syntax error.
  execFileSync(process.execPath, ['--check', script], { stdio: 'ignore' });
});

test('manual packager installs build/icon.icns and sets CFBundleIconFile', () => {
  // Codex blocker: P12 PACKAGE-ONCE uses this manual script, not electron-builder,
  // so 0008 must explicitly carry the new icon.
  const pkgPath = path.join(ROOT, 'scripts', 'package-ai-video-mac-app.mjs');
  const pkg = fs.readFileSync(pkgPath, 'utf8');
  // 1) References the generated icon source.
  assert.ok(/['"]build['"]\s*,\s*['"]icon\.icns['"]/.test(pkg), 'packager does not reference build/icon.icns');
  // 2) Copies it into the bundle Resources.
  assert.ok(
    /cpSync\(\s*customAppIcon\s*,\s*join\(\s*resources\s*,\s*['"]icon\.icns['"]\s*\)/.test(pkg),
    'packager does not copy icon into Contents/Resources/icon.icns',
  );
  // 3) Repoints Info.plist CFBundleIconFile at the new icon.
  assert.ok(pkg.includes('CFBundleIconFile'), 'packager does not touch CFBundleIconFile');
  assert.ok(
    /CFBundleIconFile[\s\S]{0,120}<string>icon\.icns<\/string>/.test(pkg),
    'packager does not set CFBundleIconFile to icon.icns',
  );
  // 4) Conservative fallback: missing icon warns but does not abort packaging.
  assert.ok(/未找到 build\/icon\.icns/.test(pkg), 'packager lacks a graceful missing-icon fallback');
  // Syntactically valid.
  execFileSync(process.execPath, ['--check', pkgPath], { stdio: 'ignore' });
});

test('shared commonCSS still defines the core component classes', () => {
  // UI polish must keep the shared component vocabulary intact.
  for (const cls of ['.card', '.btn-primary', '.btn-secondary', '.badge', '.alert-ok', '.alert-err', '.progress-bar', '.shot-row']) {
    assert.ok(SERVE.includes(cls), `commonCSS missing component class: ${cls}`);
  }
  // alert-info is now defined (was previously referenced but unstyled).
  assert.ok(SERVE.includes('.alert-info{'), 'alert-info style not defined');
});
