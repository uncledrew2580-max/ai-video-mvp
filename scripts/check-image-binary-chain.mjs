#!/usr/bin/env node
/**
 * check-image-binary-chain.mjs — Read-only image/binary chain audit
 *
 * Checks (static source analysis only — no processes started):
 *   1. UI copy does NOT contain "只用文字生成" / "纯文字生成" / "没有图片也可以" text-only fallback
 *   2. Upload input field-5 is present, accepts jpg/png, has required attribute
 *   3. submitProductToN8n validates at least 1 image before forwarding to n8n
 *   4. rerunDirectorConcepts throws clear error when uniqueImagePaths.length === 0
 *   5. Creative direction request body includes inline_data / image_url conversion for images
 *   6. kie_openai_chat path converts inline_data → image_url data URI (not dropped)
 *   7. WORKFLOW_DATA_ROOT dist branch points to App Support/workflow-data (not .app bundle)
 *   8. CONCEPT_CONTEXT_ROOT is under WORKFLOW_DATA_ROOT (not hardcoded path)
 *   9. Script does NOT output base64 content in any console.log or response
 *  10. Image collection comment no longer says "no hard requirement"
 *
 * NEVER reads or outputs API Key, base64 image data, or secret values.
 *
 * Usage: node scripts/check-image-binary-chain.mjs
 * Exit 0 = all clear, Exit 1 = issues found
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE_PATH = path.join(PROJECT_ROOT, '版本测试', 'serve-review-assets.mjs');

const rows = [];
let anyFail = false;

function addRow(check, status, detail) {
  rows.push({ check, status, detail });
  if (status === 'FAIL') anyFail = true;
}

if (!fs.existsSync(SERVE_PATH)) {
  console.error(`serve-review-assets.mjs not found: ${SERVE_PATH}`);
  process.exit(2);
}

const src = fs.readFileSync(SERVE_PATH, 'utf8');

// ── Check 1: No text-only fallback copy ──────────────────────────────────────
{
  const textOnlyPatterns = [
    /没有图片也可以只用文字生成/,
    /没有图片也可以纯文字生成/,
    /不上传图片.*AI.*根据文字.*正常运行/,
    /0[–-]5\s*张产品图片.*纯文字/,
  ];
  const hits = textOnlyPatterns.filter(p => p.test(src));
  addRow(
    'UI copy: no "text-only fallback" messaging',
    hits.length === 0 ? 'PASS' : 'FAIL',
    hits.length === 0
      ? 'no text-only fallback copy found'
      : `${hits.length} text-only fallback pattern(s) still present`,
  );
}

// ── Check 2: field-5 input exists, accepts images, has required ───────────────
{
  const inputLine = src.match(/<input[^>]+name="field-5"[^>]*>/)?.[0] || '';
  const hasField5 = inputLine.length > 0;
  const acceptsImages = /accept="[^"]*image/.test(inputLine);
  const hasRequired = /\brequired\b/.test(inputLine);
  addRow(
    'field-5 input: present in form',
    hasField5 ? 'PASS' : 'FAIL',
    hasField5 ? 'field-5 input found' : 'field-5 input not found in source',
  );
  addRow(
    'field-5 input: accepts jpg/png',
    acceptsImages ? 'PASS' : 'FAIL',
    acceptsImages ? 'accept attribute includes image types' : 'accept attribute missing or no image types',
  );
  addRow(
    'field-5 input: has required attribute',
    hasRequired ? 'PASS' : 'FAIL',
    hasRequired ? 'required attribute present' : 'required attribute missing — client-side validation gap',
  );
}

// ── Check 3: submitProductToN8n validates at least 1 image ────────────────────
{
  const fnStart = src.indexOf('async function submitProductToN8n(');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 10);
  const fnBody = fnStart !== -1 ? src.slice(fnStart, fnEnd !== -1 ? fnEnd : fnStart + 2000) : '';
  const hasImageCheck = /imageFiles.*filter.*field-5/.test(fnBody) || /field-5.*imageFiles/.test(fnBody);
  const hasImageError = /imageFiles\.length\s*===\s*0/.test(fnBody) || /imageFiles\.length\s*<\s*1/.test(fnBody);
  addRow(
    'submitProductToN8n: checks for field-5 image files',
    hasImageCheck ? 'PASS' : 'FAIL',
    hasImageCheck ? 'imageFiles filter for field-5 found' : 'no image file count check in submitProductToN8n',
  );
  addRow(
    'submitProductToN8n: throws error when 0 images',
    hasImageError ? 'PASS' : 'FAIL',
    hasImageError ? 'imageFiles.length === 0 guard present' : 'missing 0-image guard in submitProductToN8n',
  );
}

// ── Check 4: rerunDirectorConcepts throws when no readable images ─────────────
{
  const fnStart = src.indexOf('function rerunDirectorConcepts(');
  const fnBody = fnStart !== -1 ? src.slice(fnStart, fnStart + 3000) : '';
  const hasZeroGuard = /uniqueImagePaths\.length\s*===\s*0/.test(fnBody);
  const hasThrow = /throw new Error/.test(
    fnBody.slice(fnBody.indexOf('uniqueImagePaths.length'), fnBody.indexOf('uniqueImagePaths.length') + 400),
  );
  addRow(
    'rerunDirectorConcepts: guard when uniqueImagePaths.length === 0',
    hasZeroGuard ? 'PASS' : 'FAIL',
    hasZeroGuard ? 'zero-image guard present in rerunDirectorConcepts' : 'missing zero-image guard — model called without images',
  );
  addRow(
    'rerunDirectorConcepts: throws clear error on missing images',
    (hasZeroGuard && hasThrow) ? 'PASS' : 'FAIL',
    (hasZeroGuard && hasThrow)
      ? 'throws Error with diagnostic detail when images missing'
      : 'clear error throw not found near zero-image check',
  );
}

// ── Check 5: Creative request body includes images (inline_data) ──────────────
{
  const reqBodyStart = src.indexOf('const requestBody = {');
  const reqBodyBlock = reqBodyStart !== -1 ? src.slice(reqBodyStart, reqBodyStart + 800) : '';
  const hasInlineData = /inline_data/.test(reqBodyBlock);
  const usesUniqueImagePaths = /uniqueImagePaths\.map/.test(reqBodyBlock);
  addRow(
    'creative requestBody: maps uniqueImagePaths as inline_data',
    (hasInlineData && usesUniqueImagePaths) ? 'PASS' : 'FAIL',
    (hasInlineData && usesUniqueImagePaths)
      ? 'uniqueImagePaths.map → inline_data found in requestBody construction'
      : 'inline_data mapping not found — images may be dropped from request',
  );
}

// ── Check 6: kie_openai_chat converts inline_data → image_url (not dropped) ───
{
  const kieBlock = src.slice(
    src.indexOf('if (textConfig.adapter === \'kie_openai_chat\')'),
    src.indexOf('if (textConfig.adapter === \'kie_openai_chat\')') + 1200,
  );
  const convertsInlineData = /part\.inline_data/.test(kieBlock) && /image_url/.test(kieBlock) && /data:/.test(kieBlock);
  addRow(
    'kie_openai_chat: inline_data → image_url data URI conversion present',
    convertsInlineData ? 'PASS' : 'FAIL',
    convertsInlineData
      ? 'part.inline_data → {type:image_url, image_url:{url:data:...}} conversion found'
      : 'conversion not found — images may be silently dropped for kie_openai_chat',
  );
}

// ── Check 7: WORKFLOW_DATA_ROOT dist branch → App Support/workflow-data ───────
{
  // Find the line: if (EARLY_APP_MODE === 'dist') return path.join(EARLY_APP_SUPPORT_DIR, 'workflow-data');
  const distLine = src.match(/EARLY_APP_MODE\s*===\s*['"]dist['"]\s*\)\s*return[^\n]+/)?.[0] || '';
  const hasAppSupport = distLine.includes('EARLY_APP_SUPPORT_DIR');
  const hasWorkflowData = distLine.includes('workflow-data');
  addRow(
    'WORKFLOW_DATA_ROOT (dist): uses App Support/workflow-data',
    (hasAppSupport && hasWorkflowData) ? 'PASS' : 'FAIL',
    (hasAppSupport && hasWorkflowData)
      ? 'dist branch = join(EARLY_APP_SUPPORT_DIR, "workflow-data")'
      : `dist branch not found or missing expected values — line: '${distLine.slice(0, 80)}'`,
  );
}

// ── Check 8: CONCEPT_CONTEXT_ROOT is under WORKFLOW_DATA_ROOT ─────────────────
{
  const ccrDef = src.match(/const CONCEPT_CONTEXT_ROOT\s*=\s*([^\n]+)/)?.[1] || '';
  const underWorkflowData = ccrDef.includes('WORKFLOW_DATA_ROOT') || ccrDef.includes('CACHE_ROOT');
  addRow(
    'CONCEPT_CONTEXT_ROOT: derived from WORKFLOW_DATA_ROOT/CACHE_ROOT',
    underWorkflowData ? 'PASS' : 'FAIL',
    underWorkflowData ? `CONCEPT_CONTEXT_ROOT = ${ccrDef.trim().slice(0, 80)}` : 'CONCEPT_CONTEXT_ROOT not derived from WORKFLOW_DATA_ROOT',
  );
}

// ── Check 9: Script does not log base64 content ───────────────────────────────
{
  // Look for any console.log that could include .toString('base64') directly
  const base64Logs = [...src.matchAll(/console\.(log|error|warn)\([^)]*base64[^)]*\)/g)];
  addRow(
    'no console.log of base64 image content',
    base64Logs.length === 0 ? 'PASS' : 'WARN',
    base64Logs.length === 0
      ? 'no console.log with base64 content found'
      : `${base64Logs.length} potential base64 log(s) — verify manually`,
  );
}

// ── Check 10: Image collection comment updated (no "no hard requirement") ──────
{
  const oldComment = /Collect images.*no hard requirement/.test(src);
  addRow(
    'image collection comment: no longer says "no hard requirement"',
    !oldComment ? 'PASS' : 'FAIL',
    !oldComment ? 'old "no hard requirement" comment removed' : 'stale comment still says "no hard requirement"',
  );
}

// ── Render ────────────────────────────────────────────────────────────────────
const COL = { check: 62, status: 8 };
const header = ['check'.padEnd(COL.check), 'status'.padEnd(COL.status), 'detail'].join('  ');
const sep = '-'.repeat(header.length);

console.log('\n=== check-image-binary-chain — static analysis, no secret/base64 output ===\n');
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
  console.log('\n❌ RESULT: One or more image/binary chain checks FAILED.');
  process.exit(1);
} else {
  console.log('\n✅ RESULT: All image/binary chain checks passed.');
  process.exit(0);
}
