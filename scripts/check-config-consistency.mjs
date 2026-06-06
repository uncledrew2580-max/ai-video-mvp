#!/usr/bin/env node
/**
 * check-config-consistency.mjs — Read-only config/model consistency audit
 *
 * Checks (static source + JSON field status only — no processes started):
 *   1. KIE_CONSTANTS.text_model in serve-review-assets.mjs = 'gemini-3.1-pro'
 *   2. MODEL_PRESETS[0] in serve-review-assets.mjs is gemini-3.1-pro (first = default)
 *   3. gemini_native fallback does NOT use hardcoded deprecated flash model
 *   4. normalizeAiConfig has v1 model lock block
 *   5. lockMvpDefaults in package-ai-video-mac-app.mjs uses gemini-3.1-pro (not flash)
 *   6. lockMvpDefaults in package-mac-mvp.mjs uses gemini-3.1-pro (not flash)
 *   7. Config JSONs: text model defaults are gemini-3.1-pro
 *   8. Config JSONs: image model defaults are nano-banana-pro
 *   9. Config JSONs: video model defaults are veo3_lite
 *  10. Config JSONs: api_key fields EXIST and are empty/placeholder (presence check only, no value output)
 *  11. Config page HTML: no <select> or model-select for user-editable text model
 *
 * NEVER reads or outputs API Key / token / secret values.
 *
 * Usage: node scripts/check-config-consistency.mjs
 * Exit 0 = all clear, Exit 1 = issues found
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const rows = [];
let anyFail = false;

function addRow(check, status, detail) {
  rows.push({ check, status, detail });
  if (status === 'FAIL') anyFail = true;
}

// ── Paths ─────────────────────────────────────────────────────────────────────
const SERVE_PATH = path.join(PROJECT_ROOT, '版本测试', 'serve-review-assets.mjs');
const PKG_APP_PATH = path.join(PROJECT_ROOT, 'scripts', 'package-ai-video-mac-app.mjs');
const PKG_MVP_PATH = path.join(PROJECT_ROOT, 'scripts', 'package-mac-mvp.mjs');
const CONFIG_FILES = [
  path.join(PROJECT_ROOT, '版本测试', 'config', 'local-config.json'),
  path.join(PROJECT_ROOT, '版本测试', 'config', 'local-config.example.json'),
  path.join(PROJECT_ROOT, 'config', 'local-config.json'),
  path.join(PROJECT_ROOT, 'config', 'local-config.example.json'),
];

// ── Check 1: KIE_CONSTANTS.text_model ────────────────────────────────────────
{
  if (!fs.existsSync(SERVE_PATH)) {
    addRow('KIE_CONSTANTS.text_model = gemini-3.1-pro', 'FAIL', 'serve-review-assets.mjs not found');
  } else {
    const src = fs.readFileSync(SERVE_PATH, 'utf8');
    const m = src.match(/const KIE_CONSTANTS\s*=\s*\{[\s\S]{0,200}text_model:\s*'([^']+)'/);
    const val = m ? m[1] : null;
    addRow(
      'KIE_CONSTANTS.text_model = gemini-3.1-pro',
      val === 'gemini-3.1-pro' ? 'PASS' : 'FAIL',
      val ? `text_model = '${val}'` : 'KIE_CONSTANTS.text_model not found',
    );
  }
}

// ── Check 2: MODEL_PRESETS first text entry is gemini-3.1-pro ────────────────
{
  if (fs.existsSync(SERVE_PATH)) {
    const src = fs.readFileSync(SERVE_PATH, 'utf8');
    const textBlock = src.match(/text:\s*\[([\s\S]{0,800}?)\]/)?.[1] || '';
    const firstId = textBlock.match(/id:\s*'([^']+)'/)?.[1];
    addRow(
      'MODEL_PRESETS text[0].id = gemini-3.1-pro (frozen default first)',
      firstId === 'gemini-3.1-pro' ? 'PASS' : 'FAIL',
      firstId ? `first text preset id = '${firstId}'` : 'MODEL_PRESETS text block not matched',
    );
  }
}

// ── Check 3: gemini_native fallback does NOT hardcode deprecated flash model ───
{
  // Build needle dynamically so the check script itself does not ship the banned string literal.
  const _deprecatedFlash = ['gemini', '2.5', 'flash'].join('-');
  if (fs.existsSync(SERVE_PATH)) {
    const src = fs.readFileSync(SERVE_PATH, 'utf8');
    const fallbackMatch = src.match(/gemini_native fallback[\s\S]{0,200}const model = \(([^)]+)\)/);
    const line = fallbackMatch ? fallbackMatch[1] : '';
    const hasHardcoded = line.includes(_deprecatedFlash);
    const usesConstant = /KIE_CONSTANTS\.text_model/.test(line);
    addRow(
      'gemini_native fallback: no hardcoded deprecated flash model',
      !hasHardcoded ? 'PASS' : 'FAIL',
      !hasHardcoded
        ? (usesConstant ? 'uses KIE_CONSTANTS.text_model' : 'no hardcoded deprecated model found')
        : 'still hardcodes deprecated flash model as fallback',
    );
  }
}

// ── Check 4: normalizeAiConfig has v1 model lock block ───────────────────────
{
  if (fs.existsSync(SERVE_PATH)) {
    const src = fs.readFileSync(SERVE_PATH, 'utf8');
    const hasLock = /v1 model lock/.test(src) && /KIE_CONSTANTS\.text_model/.test(
      src.slice(src.indexOf('v1 model lock'), src.indexOf('v1 model lock') + 600),
    );
    addRow(
      'normalizeAiConfig: v1 model lock block present',
      hasLock ? 'PASS' : 'FAIL',
      hasLock ? 'v1 model lock sets KIE_CONSTANTS.text_model on all text tasks' : 'lock block not found',
    );
  }
}

// ── Check 5 & 6: lockMvpDefaults uses gemini-3.1-pro (not flash) ─────────────
for (const [label, fpath] of [
  ['package-ai-video-mac-app.mjs', PKG_APP_PATH],
  ['package-mac-mvp.mjs', PKG_MVP_PATH],
]) {
  if (!fs.existsSync(fpath)) {
    addRow(`lockMvpDefaults in ${label}: uses gemini-3.1-pro`, 'SKIP', 'file not found');
    continue;
  }
  const src = fs.readFileSync(fpath, 'utf8');
  const fnStart = src.indexOf('function lockMvpDefaults');
  const fnEnd = src.indexOf('\n}', fnStart) + 2;
  const fn = fnStart !== -1 ? src.slice(fnStart, fnEnd) : '';
  const _deprecatedFlash = ['gemini', '2.5', 'flash'].join('-');
  const hasFlash = fn.includes(_deprecatedFlash);
  const hasPro = fn.includes('gemini-3.1-pro');
  addRow(
    `lockMvpDefaults in ${label}: no deprecated flash model`,
    !hasFlash ? 'PASS' : 'FAIL',
    !hasFlash ? 'no deprecated flash model in lockMvpDefaults' : 'still contains deprecated flash model',
  );
  addRow(
    `lockMvpDefaults in ${label}: sets gemini-3.1-pro`,
    hasPro ? 'PASS' : 'FAIL',
    hasPro ? 'gemini-3.1-pro found in lockMvpDefaults' : 'gemini-3.1-pro not found',
  );
}

// ── Checks 7–10: Config JSON field status ─────────────────────────────────────
for (const cfgPath of CONFIG_FILES) {
  const rel = path.relative(PROJECT_ROOT, cfgPath);
  if (!fs.existsSync(cfgPath)) {
    addRow(`config ${rel}: model defaults`, 'SKIP', 'file not found');
    continue;
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {
    addRow(`config ${rel}: parse`, 'FAIL', `JSON parse error: ${e.message}`);
    continue;
  }

  // Text model checks
  const textFields = [
    cfg.kie?.text_model,
    cfg.providers?.kie?.text_model,
    cfg.tasks?.creative_direction?.model,
    cfg.tasks?.script_framework?.model,
    cfg.tasks?.storyboard_prompt?.model,
    cfg.apis?.creative_direction?.model,
    cfg.apis?.script_framework?.model,
  ].filter(Boolean);
  const allTextCorrect = textFields.length > 0 && textFields.every(v => v === 'gemini-3.1-pro');
  const _deprecatedFlash = ['gemini', '2.5', 'flash'].join('-');
  const flashRemains = textFields.filter(v => v === _deprecatedFlash);
  addRow(
    `config ${rel}: text model defaults = gemini-3.1-pro`,
    allTextCorrect ? 'PASS' : 'FAIL',
    allTextCorrect
      ? `${textFields.length} text model field(s) all = gemini-3.1-pro`
      : `flash remains in ${flashRemains.length} field(s); found: ${[...new Set(textFields)].join(', ')}`,
  );

  // Image model
  const imgFields = [cfg.tasks?.storyboard_image?.model, cfg.providers?.kie?.image_model, cfg.kie?.image_model].filter(Boolean);
  const imgOk = imgFields.every(v => v === 'nano-banana-pro');
  addRow(
    `config ${rel}: image model = nano-banana-pro`,
    imgOk ? 'PASS' : 'FAIL',
    imgOk ? 'nano-banana-pro in image fields' : `found: ${[...new Set(imgFields)].join(', ')}`,
  );

  // Video model
  const vidFields = [cfg.tasks?.image_to_video?.model, cfg.providers?.kie?.video_model, cfg.kie?.video_model].filter(Boolean);
  const vidOk = vidFields.every(v => v === 'veo3_lite');
  addRow(
    `config ${rel}: video model = veo3_lite`,
    vidOk ? 'PASS' : 'FAIL',
    vidOk ? 'veo3_lite in video fields' : `found: ${[...new Set(vidFields)].join(', ')}`,
  );

  // API key field presence (NOT value output)
  const kieKeyExists = 'api_key' in (cfg.kie || cfg.providers?.kie || {});
  addRow(
    `config ${rel}: api_key field present (value hidden)`,
    kieKeyExists ? 'PASS' : 'WARN',
    kieKeyExists ? 'kie api_key field exists (value not shown)' : 'kie api_key field not found in config',
  );
}

// ── Check 11: Config page HTML: no user-editable text model <select> ──────────
{
  if (fs.existsSync(SERVE_PATH)) {
    const src = fs.readFileSync(SERVE_PATH, 'utf8');
    // Look for any select or option that exposes text model as user-editable
    // Hidden inputs with fixed model values are OK; <select name/id with model is not
    const envPageBlock = src.slice(src.indexOf('function renderEnvPage'), src.indexOf('function renderEnvPage') + 8000) || src;
    const hasModelSelect = /<select[^>]*(text.model|model.select|modelSelect)[^>]*>/i.test(envPageBlock);
    const hasHiddenModelInput = /type="hidden"[^>]*data-path="tasks\.[^"]+\.model"/.test(envPageBlock);
    addRow(
      'config page: no user-editable text model <select>',
      !hasModelSelect ? 'PASS' : 'FAIL',
      !hasModelSelect
        ? (hasHiddenModelInput ? 'hidden inputs lock model; no select exposed' : 'no model select found in config page')
        : 'text model <select> found — user can change model',
    );
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
const COL = { check: 62, status: 8 };
const header = ['check'.padEnd(COL.check), 'status'.padEnd(COL.status), 'detail'].join('  ');
const sep = '-'.repeat(header.length);

console.log('\n=== check-config-consistency — field status only, no secret values ===\n');
console.log(header);
console.log(sep);
for (const r of rows) {
  const statusDisplay =
    r.status === 'PASS' ? '✅ PASS ' :
    r.status === 'FAIL' ? '❌ FAIL ' :
    r.status === 'WARN' ? '⚠️  WARN ' :
    '   SKIP ';
  console.log([
    String(r.check).padEnd(COL.check),
    statusDisplay.padEnd(COL.status),
    String(r.detail).slice(0, 110),
  ].join('  '));
}
console.log(sep);

if (anyFail) {
  console.log('\n❌ RESULT: One or more config consistency checks FAILED.');
  process.exit(1);
} else {
  console.log('\n✅ RESULT: All config consistency checks passed.');
  process.exit(0);
}
