import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

const promptFiles = [
  path.join(repoRoot, 'prompts', 'prompt_center.json'),
  path.join(repoRoot, '版本测试', 'prompts', 'prompt_center.json'),
];

const workflowFiles = [
  path.join(repoRoot, '正式导入文件', 'iteration-v1', 'n8n01.json'),
  path.join(repoRoot, '正式导入文件', 'iteration-v1', 'n8n02b.json'),
  path.join(repoRoot, '正式导入文件', 'iteration-v1', 'n8n03.json'),
];

const requiredModules = [
  'director',
  'script',
  'storyboard',
  'nanobanana_image',
  'voice_localization',
  'veo_quality_constraints',
  'creative_task_type_mapping',
];

const contractFields = [
  'project_id',
  'review_context_path',
  'review_round',
  'review_decision',
  'bad_shot_ids',
  'rerun_pending_only',
  'rerun_failed_only',
  'shot_id',
  'shot_order',
  'operation_name',
  'video_path',
  'final_merged_video_path',
  'script_overview',
  'shots',
  'stage',
  'duration',
  'scene_setting',
  'visual_action',
  'product_state',
  'camera_movement',
  'expression_focus',
  'optional_voiceover_local',
  'continuity_requirements',
  'panel_review_pack',
  'video_prompt',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compact(value) {
  return JSON.stringify(value);
}

for (const promptFile of promptFiles) {
  const promptCenter = readJson(promptFile);
  const raw = compact(promptCenter);

  for (const moduleName of requiredModules) {
    assert.ok(promptCenter[moduleName], `${promptFile} must keep ${moduleName}`);
  }

  assert.ok(
    promptCenter.script.system_instruction.includes('TikTok 测品广告 6-shot 执行蓝图约束'),
    `${promptFile} script must include the 6-shot ad blueprint constraints`,
  );
  for (const token of ['shot 1', 'shot 2', 'shot 3', 'shot 4', 'shot 5', 'shot 6']) {
    assert.ok(promptCenter.script.system_instruction.includes(token), `${promptFile} script must mention ${token}`);
  }
  for (const field of [
    'script_overview',
    'shots',
    'shot_id',
    'stage',
    'duration',
    'scene_setting',
    'visual_action',
    'product_state',
    'camera_movement',
    'expression_focus',
    'optional_voiceover_local',
    'continuity_requirements',
  ]) {
    assert.ok(raw.includes(field), `${promptFile} must keep schema field ${field}`);
  }

  assert.ok(
    promptCenter.storyboard.system_instruction.includes('6 首帧信息递进与去同质化约束'),
    `${promptFile} storyboard must include panel differentiation constraints`,
  );
  assert.ok(
    promptCenter.storyboard.system_instruction.includes('不同广告信息任务'),
    `${promptFile} storyboard must require different ad information tasks`,
  );
  assert.ok(
    promptCenter.storyboard.system_instruction.includes('禁止多个 panel'),
    `${promptFile} storyboard must prevent homogeneous panels`,
  );

  const nano = promptCenter.nanobanana_image;
  assert.ok(nano.english_storyboard_wrapper.includes('6 panels'), `${promptFile} Nano wrapper must keep 6-panel constraint`);
  assert.ok(nano.english_storyboard_wrapper.includes('3 columns × 2 rows'), `${promptFile} Nano wrapper must keep 3x2 layout`);
  assert.equal(nano.gemini_image_config.aspectRatio, '4:5', `${promptFile} Nano config must keep 4:5 canvas`);
  assert.ok(nano.english_storyboard_wrapper.includes('no text overlay'), `${promptFile} Nano wrapper must keep no text overlay`);
  assert.ok(nano.english_storyboard_wrapper.includes('no watermark'), `${promptFile} Nano wrapper must keep no watermark`);
  assert.ok(
    nano.english_storyboard_wrapper.includes('TikTok UGC ad-frame requirements'),
    `${promptFile} Nano wrapper must include TikTok UGC ad-frame requirements`,
  );

  const voiceRaw = compact(promptCenter.voice_localization);
  assert.ok(voiceRaw.includes('short dense local'), `${promptFile} voice localization must require short dense local phrasing`);
  assert.ok(voiceRaw.includes('same speaker'), `${promptFile} voice localization must require same speaker continuity`);
  assert.ok(voiceRaw.includes('same voice tone'), `${promptFile} voice localization must require same voice tone`);

  const qualityRaw = compact(promptCenter.veo_quality_constraints);
  assert.ok(qualityRaw.includes('silhouette'), `${promptFile} Veo quality constraints must lock product silhouette`);
  assert.ok(qualityRaw.includes('key components'), `${promptFile} Veo quality constraints must lock key components`);
  assert.ok(qualityRaw.includes('no glossy commercial look'), `${promptFile} Veo quality constraints must reduce commercial/AI look`);
  assert.ok(qualityRaw.includes('no random text'), `${promptFile} Veo quality constraints must keep random text ban`);

  const pain = promptCenter.creative_task_type_mapping['痛点前置'];
  assert.ok(pain, `${promptFile} must keep 痛点前置 creative task type`);
  const painRaw = compact(pain);
  assert.ok(painRaw.includes('first 1-2 seconds'), `${promptFile} 痛点前置 must require fast pain/result hook`);
  assert.ok(painRaw.includes('quickly reveal the product'), `${promptFile} 痛点前置 must require quick solution reveal`);

  for (const banned of ['除尘掸子', '越南', '清洁产品']) {
    assert.equal(raw.includes(banned), false, `${promptFile} must not hard-code sample product/market term: ${banned}`);
  }

  console.log(`PASS prompt center checks: ${path.relative(repoRoot, promptFile)}`);
}

for (const workflowFile of workflowFiles) {
  readJson(workflowFile);
  console.log(`PASS workflow JSON parse: ${path.relative(repoRoot, workflowFile)}`);
}

for (const workflowFile of [
  path.join(repoRoot, '正式导入文件', 'iteration-v1', 'n8n01.json'),
  path.join(repoRoot, '正式导入文件', 'iteration-v1', 'n8n02b.json'),
]) {
  const workflowRaw = fs.readFileSync(workflowFile, 'utf8');
  assert.ok(workflowRaw.includes('Do not create a new story or new selling angle'), `${workflowFile} Veo prompt must obey script`);
  assert.ok(workflowRaw.includes('Eight-second ad task pacing'), `${workflowFile} Veo prompt must enforce 8-second task density`);
  assert.ok(workflowRaw.includes('Product lock:'), `${workflowFile} Veo prompt must include product lock`);
  assert.ok(workflowRaw.includes('same speaker'), `${workflowFile} Veo prompt must include voice continuity`);
  assert.ok(workflowRaw.includes('no random text'), `${workflowFile} Veo prompt must preserve random text ban`);
  const newConstraintText = [
    'Do not create a new story or new selling angle',
    'Eight-second ad task pacing',
    'Product lock:',
    'Voice continuity:',
  ].map((token) => {
    const idx = workflowRaw.indexOf(token);
    assert.ok(idx > 0, `${workflowFile} must contain new constraint token: ${token}`);
    return workflowRaw.slice(idx, idx + 420);
  }).join('\n');
  for (const banned of ['除尘掸子', '越南', '清洁产品']) {
    assert.equal(newConstraintText.includes(banned), false, `${workflowFile} new constraints must not hard-code sample term: ${banned}`);
  }
  console.log(`PASS Veo execution constraints: ${path.relative(repoRoot, workflowFile)}`);
}

const n8n03 = readJson(path.join(repoRoot, '正式导入文件', 'iteration-v1', 'n8n03.json'));
const webhook = n8n03.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');
assert.equal(webhook?.parameters?.path, 'storyboard-review-submit-v2', 'reviewSubmitVeoV2 webhook path must stay unchanged');
assert.equal(webhook?.parameters?.httpMethod, 'POST', 'reviewSubmitVeoV2 webhook method must stay POST');

const contractHaystack = workflowFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  + '\n'
  + promptFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
for (const field of contractFields) {
  assert.ok(contractHaystack.includes(field), `contract field must remain present: ${field}`);
}

console.log('PASS contract fields and webhook path/method preserved');
