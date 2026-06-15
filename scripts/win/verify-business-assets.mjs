#!/usr/bin/env node
// Verify that the Windows portable runtime carries the current business assets:
// prompts, workflow JSON, and the UI/service guards that protect paid video runs.
// Usage:
//   node scripts/win/verify-business-assets.mjs
//   node scripts/win/verify-business-assets.mjs dist-win/AI-Video-Win-x64-Portable-RC-0001/resources/runtime

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const targetRoot = path.resolve(process.argv[2] || ROOT);
const sourceRoot = path.resolve(process.argv[3] || ROOT);
const compareToSource = targetRoot !== sourceRoot;

const workflowRels = [
  '正式导入文件/iteration-v1/n8n01.json',
  '正式导入文件/iteration-v1/n8n02.json',
  '正式导入文件/iteration-v1/n8n02a.json',
  '正式导入文件/iteration-v1/n8n02b.json',
  '正式导入文件/iteration-v1/n8n03.json',
];

const requiredFiles = [
  ...walkFiles(path.join(sourceRoot, 'prompts')).map((file) => path.relative(sourceRoot, file)),
  ...walkFiles(path.join(sourceRoot, '版本测试', 'prompts')).map((file) => path.relative(sourceRoot, file)),
  ...workflowRels,
  '版本测试/serve-review-assets.mjs',
];

const failures = [];
const hashes = {};

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name !== '.DS_Store') out.push(full);
    }
  }
  return out.sort();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function read(rel, root = targetRoot) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function readJson(rel, root = targetRoot) {
  return JSON.parse(read(rel, root));
}

function getNode(workflow, name) {
  return (workflow.nodes || []).find((node) => node.name === name);
}

function assert(ok, message) {
  if (!ok) failures.push(message);
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label} missing "${needle}"`);
}

function assertNotIncludes(text, needle, label) {
  assert(!text.includes(needle), `${label} must not include "${needle}"`);
}

function verifyFileSet() {
  for (const rel of requiredFiles) {
    const target = path.join(targetRoot, rel);
    const source = path.join(sourceRoot, rel);
    assert(fs.existsSync(target), `missing target asset: ${rel}`);
    assert(fs.existsSync(source), `missing source asset: ${rel}`);
    if (!fs.existsSync(target) || !fs.existsSync(source)) continue;

    const targetHash = sha256(target);
    hashes[rel] = targetHash;
    if (compareToSource) {
      const sourceHash = sha256(source);
      assert(targetHash === sourceHash, `asset hash mismatch: ${rel} target=${targetHash} source=${sourceHash}`);
    }
  }
}

function verifyPrompts() {
  const rootPrompt = path.join(targetRoot, 'prompts', 'prompt_center.json');
  const uiPrompt = path.join(targetRoot, '版本测试', 'prompts', 'prompt_center.json');
  assert(fs.existsSync(rootPrompt), 'missing prompts/prompt_center.json');
  assert(fs.existsSync(uiPrompt), 'missing 版本测试/prompts/prompt_center.json');
  if (!fs.existsSync(rootPrompt) || !fs.existsSync(uiPrompt)) return;

  assert(sha256(rootPrompt) === sha256(uiPrompt), 'prompt_center root copy and UI seed copy must be identical');
  const raw = fs.readFileSync(rootPrompt, 'utf8');
  JSON.parse(raw);
  for (const needle of [
    'TikTok UGC',
    'Hook',
    '6-shot ad task progression',
    'same speaker',
    'same voice tone',
    'Eight-second task',
    'Product fidelity is the highest priority',
    'Preserve the product exactly as shown in the first frame',
  ]) {
    assertIncludes(raw, needle, 'prompt_center quality sentinel');
  }
}

function verifyWf02b() {
  const wf = readJson('正式导入文件/iteration-v1/n8n02b.json');
  const raw = JSON.stringify(wf);
  for (const needle of [
    'PRODUCT_IDENTITY_SCORE_THRESHOLD',
    'product_reference_image_paths',
    'product_identity_reference_paths',
    'product_reference_strategy',
    'product_identity_references_first',
    'PRODUCT IDENTITY REFERENCE',
    'master product-body references',
    'usage/detail reference only',
    'Lifestyle/use-case/detail images may guide hand placement',
    'Product fidelity outranks storytelling',
    'max_product_reference_images',
  ]) {
    assertIncludes(raw, needle, 'WF02B product identity sentinel');
  }
  for (const oldLock of [
    'Image 1 is the product reference',
    'four-grid',
    '4-grid',
    '四宫格',
  ]) {
    assertNotIncludes(raw, oldLock, 'WF02B old hard-coded image/grid rule');
  }

  const imageNode = getNode(wf, '本地图片转Gemini输入');
  const assembleNode = getNode(wf, '组装NanoBanana执行字段');
  assert(Boolean(imageNode?.parameters?.jsCode), 'WF02B missing 本地图片转Gemini输入 code node');
  assert(Boolean(assembleNode?.parameters?.jsCode), 'WF02B missing 组装NanoBanana执行字段 code node');
  if (imageNode?.parameters?.jsCode) {
    assertIncludes(imageNode.parameters.jsCode, '...imagePaths', 'WF02B image collector');
    assertIncludes(imageNode.parameters.jsCode, '...metaImages.map(pathFromMeta)', 'WF02B image collector');
    assertIncludes(imageNode.parameters.jsCode, 'selectedPaths.length', 'WF02B image collector');
  }
  if (assembleNode?.parameters?.jsCode) {
    assertIncludes(assembleNode.parameters.jsCode, 'index <= max', 'WF02B reference image loop');
    assertIncludes(assembleNode.parameters.jsCode, 'parts.push({ inlineData', 'WF02B image model request');
  }
}

function verifyWf03() {
  const wf = readJson('正式导入文件/iteration-v1/n8n03.json');
  const batchNode = getNode(wf, 'Veo逐镜串行');
  assert(batchNode?.parameters?.batchSize === 3, 'WF03 Veo逐镜串行 batchSize must be 3');

  for (const name of ['Veo进度_开始分镜', 'Veo进度_已提交任务', 'Veo进度_完成分镜']) {
    const code = getNode(wf, name)?.parameters?.jsCode || '';
    assertIncludes(code, '$input.all()', `WF03 ${name}`);
    assertIncludes(code, 'items.map', `WF03 ${name}`);
  }

  const summaryCode = getNode(wf, 'Veo结果汇总')?.parameters?.jsCode || '';
  assertIncludes(summaryCode, 'completedCount >= totalPanels', 'WF03 summary paused clear');
  assertIncludes(summaryCode, 'false : Boolean(progress.paused)', 'WF03 summary paused clear');
}

function verifyServiceGuards() {
  const raw = read('版本测试/serve-review-assets.mjs');
  for (const needle of [
    'allClipsComplete',
    'rawIsPaused',
    '/review-rerun-pending',
    '_pausedResumeSafe',
    'if (_activeCheck.active && !_pausedResumeSafe)',
    'pendingCount',
  ]) {
    assertIncludes(raw, needle, 'serve-review-assets video continuation guard');
  }
}

verifyFileSet();
verifyPrompts();
verifyWf02b();
verifyWf03();
verifyServiceGuards();

if (failures.length) {
  console.error('[business-assets] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[business-assets] OK');
console.log(JSON.stringify({
  target_root: targetRoot,
  source_root: sourceRoot,
  compare_to_source: compareToSource,
  checked_files: requiredFiles.length,
  hashes: Object.fromEntries(Object.entries(hashes).filter(([rel]) => [
    'prompts/prompt_center.json',
    '版本测试/prompts/prompt_center.json',
    '正式导入文件/iteration-v1/n8n02b.json',
    '正式导入文件/iteration-v1/n8n03.json',
    '版本测试/serve-review-assets.mjs',
  ].includes(rel))),
}, null, 2));
