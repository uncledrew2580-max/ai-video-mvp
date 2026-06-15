/**
 * PROMPT-P2B nonpaid tests — runtime-visible verification
 * Verifies: Hook taxonomy, shot task checklist, complex product breakdown,
 *   voiceover emotion arc (via runtime-read fields), Nano first-frame matrix,
 *   Veo execution layer (via n8n02b videoPrompt code), no hardcoded product,
 *   field contract unchanged, prompt assembly preview.
 * All non-paid: no model calls, no n8n exec, no UI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const PC_PATH   = path.join(ROOT, 'prompts', 'prompt_center.json');
const PC2_PATH  = path.join(ROOT, '版本测试', 'prompts', 'prompt_center.json');
const N8N01     = path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n01.json');
const N8N02B    = path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n02b.json');
const N8N02A    = path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n02a.json');

function loadPc(p)  { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function loadWf(p)  { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function compact(v) { return JSON.stringify(v, null, 0); }
function wfNodeCode(wf, name) {
  const node = wf.nodes?.find(n => n.name === name);
  return node?.parameters?.jsCode || '';
}

function assertBoth(label, fn) {
  for (const p of [PC_PATH, PC2_PATH]) {
    fn(loadPc(p), path.relative(ROOT, p));
  }
  console.log(`PASS [${label}]`);
}

// ═══ [1] JSON validity + sync ════════════════════════════════════════════════
{
  const pc1 = loadPc(PC_PATH);
  const pc2 = loadPc(PC2_PATH);
  assert.deepEqual(pc1, pc2, 'both prompt_center.json files must be identical');
  console.log('PASS [1] JSON valid and in sync');
}

// ═══ [2] Required modules intact ════════════════════════════════════════════
{
  assertBoth('2', (pc, file) => {
    for (const m of ['director','script','storyboard','nanobanana_image','voice_localization','veo_quality_constraints','creative_task_type_mapping']) {
      assert.ok(pc[m], `${file}: module "${m}" must exist`);
    }
  });
}

// ═══ [3] Hook taxonomy — director.system_instruction (runtime-visible to WF01) ═
{
  assertBoth('3', (pc, file) => {
    const ds = pc.director.system_instruction;
    // WF01 sends director.system_instruction as system_prompt to Gemini
    assert.ok(ds.includes('Hook 类型库'), `${file}: director must have Hook 类型库`);
    for (const h of ['痛点暴击','极致反差','结果预期','误区纠正','损失预警','场景代入','即时证明']) {
      assert.ok(ds.includes(h), `${file}: director Hook taxonomy must list "${h}"`);
    }
    for (const e of ['FOMO','共鸣','好奇','焦虑','惊喜']) {
      assert.ok(ds.includes(e), `${file}: director taxonomy must reference emotion "${e}"`);
    }
    for (const bad of ['除尘掸','掸子','空调','越南']) {
      assert.ok(!ds.includes(bad), `${file}: director taxonomy must not hardcode "${bad}"`);
    }
  });
}

// ═══ [4] WF02a runtime: script.system_instruction carries Checklist + Breakdown ══
{
  assertBoth('4', (pc, file) => {
    const ss = pc.script.system_instruction;
    // n8n02a脚本请求体组装 uses prompts.script.system_instruction as system_prompt
    assert.ok(ss.includes('Shot Task Checklist'), `${file}: script.system_instruction must carry Shot Task Checklist`);
    assert.ok(ss.includes('广告任务'), `${file}: checklist must include 广告任务`);
    assert.ok(ss.includes('产品任务'), `${file}: checklist must include 产品任务`);
    assert.ok(ss.includes('动作任务'), `${file}: checklist must include 动作任务`);
    assert.ok(ss.includes('口播任务'), `${file}: checklist must include 口播任务`);
    assert.ok(ss.includes('复杂产品功能拆解原则'), `${file}: script.system_instruction must carry 复杂产品功能拆解原则`);
    assert.ok(ss.includes('一镜头只做一个功能点') || ss.includes('只做一个功能点'),
      `${file}: script must enforce one function per shot`);
    assert.ok(ss.includes('不得发明') || ss.includes('发明不存在'),
      `${file}: script must prohibit inventing product functions`);
    for (const bad of ['除尘掸','掸子']) {
      assert.ok(!ss.includes(bad), `${file}: script.system_instruction must not hardcode product name`);
    }
  });
  // Verify n8n02a actually reads prompts.script (WF02a runtime path)
  const wf02a = loadWf(N8N02A);
  const scriptNode = wfNodeCode(wf02a, '脚本请求体组装');
  assert.ok(scriptNode.includes('prompts.script'), 'n8n02a 脚本请求体组装 must read prompts.script');
  assert.ok(scriptNode.includes('s.system_instruction'), 'n8n02a must send script.system_instruction as system prompt');
  console.log('PASS [4] WF02a runtime: script.system_instruction carries Checklist + Breakdown');
}

// ═══ [5] Voice emotion arc — in runtime-read fields (tone + veo_constraints) ══
{
  assertBoth('5', (pc, file) => {
    const vl = pc.voice_localization;
    // default.tone is always read (n8n02a _vlRule.tone, n8n02b localVoiceRule.tone)
    const defTone = vl.default?.tone || '';
    assert.ok(defTone.includes('emotion arc'), `${file}: voice_localization.default.tone must contain emotion arc`);
    assert.ok(defTone.includes('Hook') || defTone.includes('urgent'),
      `${file}: default tone must describe Hook stage voice`);
    assert.ok(defTone.includes('result') || defTone.includes('satisfied') || defTone.includes('惊喜'),
      `${file}: default tone must describe result stage voice`);
    // default.veo_constraints is read by n8n02b for hardAvoid
    const defVeoC = compact(vl.default?.veo_constraints || []);
    assert.ok(defVeoC.includes('emotion arc'), `${file}: voice_localization.default.veo_constraints must reference emotion arc`);
    // VN market also carries it
    assert.ok((vl.VN?.tone || '').includes('emotion arc'),
      `${file}: voice_localization.VN.tone must contain emotion arc`);
  });
  // Verify n8n02a reads _vlRule.tone (which now carries emotion arc)
  const wf02a = loadWf(N8N02A);
  const scriptCode = wfNodeCode(wf02a, '脚本请求体组装');
  assert.ok(scriptCode.includes('_vlRule.tone'), 'n8n02a must read _vlRule.tone (which carries emotion arc)');
  // Verify n8n02b reads localVoiceRule.tone
  const wf02b = loadWf(N8N02B);
  const cropCode = wfNodeCode(wf02b, '六宫格裁切_9x16');
  assert.ok(cropCode.includes('localVoiceRule.tone'), 'n8n02b must read localVoiceRule.tone (carries emotion arc)');
  assert.ok(cropCode.includes('localCreatorTone'), 'n8n02b must inject localCreatorTone into videoPrompt');
  console.log('PASS [5] voice emotion arc runtime-visible via tone + veo_constraints (WF02a + n8n02b)');
}

// ═══ [6] Veo execution_layer — runtime-visible in n8n02b videoPrompt ════════
{
  assertBoth('6', (pc, file) => {
    const vqc = pc.veo_quality_constraints;
    assert.ok(vqc.execution_layer, `${file}: veo_quality_constraints.execution_layer must exist`);
    assert.ok(vqc.execution_layer.product_function_low_risk,
      `${file}: execution_layer.product_function_low_risk must exist`);
    assert.ok(vqc.execution_layer.script_obedience,
      `${file}: execution_layer.script_obedience must exist`);
  });
  // Verify n8n02b READS execution_layer at runtime and injects into videoPrompt
  const wf02b = loadWf(N8N02B);
  const cropCode = wfNodeCode(wf02b, '六宫格裁切_9x16');
  assert.ok(cropCode.includes('execution_layer'),
    'n8n02b 六宫格裁切_9x16 must read veo_quality_constraints.execution_layer');
  assert.ok(cropCode.includes('_execProdFn'),
    'n8n02b must extract product_function_low_risk from execution_layer');
  assert.ok(cropCode.includes('_execScriptObey'),
    'n8n02b must extract script_obedience from execution_layer');
  // The extracted values are conditionally injected into videoPrompt
  assert.ok(cropCode.includes("_execProdFn ? 'Product function execution rule:"),
    'n8n02b must inject _execProdFn into videoPrompt when non-empty');
  assert.ok(cropCode.includes("_execScriptObey ? 'Script execution rule:"),
    'n8n02b must inject _execScriptObey into videoPrompt when non-empty');
  // Simulated assembly: verify the content that will appear in video_prompt
  const pc = loadPc(PC_PATH);
  const el = pc.veo_quality_constraints.execution_layer;
  assert.ok(el.product_function_low_risk.includes('complex finger') ||
            el.product_function_low_risk.includes('complex'),
    'execution_layer.product_function_low_risk must prohibit complex finger manipulation');
  assert.ok(el.script_obedience.includes('faithfully') || el.script_obedience.includes('script shot'),
    'execution_layer.script_obedience must require faithful script execution');
  console.log('PASS [6] execution_layer runtime-visible: n8n02b reads and injects into videoPrompt');
}

// ═══ [7] Nano first-frame matrix — storyboard.system_instruction ══════════
{
  assertBoth('7', (pc, file) => {
    const sbsys = pc.storyboard.system_instruction;
    assert.ok(sbsys.includes('首帧任务矩阵'), `${file}: storyboard must have 首帧任务矩阵`);
    for (const p of ['panel 1','panel 2','panel 3','panel 4','panel 5','panel 6']) {
      assert.ok(sbsys.includes(p), `${file}: 首帧矩阵 must specify "${p}"`);
    }
    assert.ok(sbsys.includes('不出现') || sbsys.includes('产品【不出现】'),
      `${file}: matrix must specify product NOT in panel 1`);
    assert.ok(sbsys.includes('结果证明') || sbsys.includes('效果证明'),
      `${file}: matrix panel 5 must reference result proof`);
    assert.ok(sbsys.includes('转化推荐') || sbsys.includes('推荐感'),
      `${file}: matrix panel 6 must reference soft CTA`);
  });
}

// ═══ [8] No single-product hardcoding ════════════════════════════════════════
{
  assertBoth('8', (pc, file) => {
    const raw = compact(pc);
    for (const bad of ['除尘掸子','掸子','鸡毛掸','空调清洁','多功能可伸缩','Đứng ghế','lau điều hòa']) {
      assert.ok(!raw.includes(bad), `${file}: must not hardcode sample product/voiceover "${bad}"`);
    }
  });
}

// ═══ [9] Field contract unchanged ════════════════════════════════════════════
{
  assertBoth('9', (pc, file) => {
    const raw = compact(pc);
    for (const f of ['shot_id','stage','duration','scene_setting','visual_action',
                     'product_state','camera_movement','expression_focus',
                     'optional_voiceover_local','continuity_requirements',
                     'script_overview','shots','selected_concept_name_original']) {
      assert.ok(raw.includes(f), `${file}: contract field "${f}" must remain present`);
    }
  });
}

// ═══ [10] 痛点前置 mapping complete ══════════════════════════════════════════
{
  assertBoth('10', (pc, file) => {
    const pp = pc.creative_task_type_mapping['痛点前置'];
    assert.ok(pp, `${file}: 痛点前置 mapping must exist`);
    assert.ok(Array.isArray(pp.visual_focus) && pp.visual_focus.length >= 3,
      `${file}: 痛点前置.visual_focus ≥3 entries`);
    assert.ok(Array.isArray(pp.avoid) && pp.avoid.length >= 4,
      `${file}: 痛点前置.avoid ≥4 entries`);
    assert.ok(pp.script_structure?.shot_1, `${file}: 痛点前置.script_structure.shot_1 must exist`);
    const ppRaw = compact(pp);
    for (const bad of ['除尘掸','掸子']) {
      assert.ok(!ppRaw.includes(bad), `${file}: 痛点前置 must not hardcode product name`);
    }
  });
}

// ═══ [11] Nano wrapper + config ═══════════════════════════════════════════════
{
  assertBoth('11', (pc, file) => {
    const nb = pc.nanobanana_image.english_storyboard_wrapper;
    assert.ok(nb.includes('6 panels'), `${file}: nano wrapper must specify 6 panels`);
    assert.ok(nb.includes('no text overlay') || nb.includes('no watermark'),
      `${file}: nano wrapper must prohibit text overlay`);
    assert.ok(nb.includes('Product fidelity'), `${file}: nano wrapper must enforce product fidelity`);
    assert.equal(pc.nanobanana_image.gemini_image_config.aspectRatio, '4:5',
      `${file}: nano aspectRatio must stay 4:5`);
  });
}

// ═══ [12] VN voice_localization completeness ══════════════════════════════════
{
  assertBoth('12', (pc, file) => {
    const vl = pc.voice_localization;
    assert.ok(vl.VN, `${file}: VN key must exist`);
    assert.ok(Array.isArray(vl.VN.opening_patterns) && vl.VN.opening_patterns.length >= 3,
      `${file}: VN must have ≥3 opening_patterns`);
    assert.ok((vl.VN.tone || '').includes('emotion arc'),
      `${file}: VN.tone must contain emotion arc`);
  });
}

// ═══ [13] n8n workflow JSON validity (no regression from P2B patches) ════════
{
  for (const wfPath of [N8N01, N8N02A, N8N02B,
       path.join(ROOT, '正式導入文件'.normalize('NFC').replace('導', '式导'), 'iteration-v1', 'n8n01.json'),
       path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n03.json')]) {
    try {
      const wf = loadWf(wfPath);
      assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0,
        `${path.basename(wfPath)}: must have nodes array`);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // skip if path variant missing
      throw e;
    }
  }
  console.log('PASS [13] workflow JSONs valid');
}

// ═══ [14] P2B runtime assembly preview (mock product, no model call) ══════════
{
  const pc = loadPc(PC_PATH);
  const wf02a = loadWf(N8N02A);
  const wf02b = loadWf(N8N02B);

  // Simulate WF02a: script system_instruction reaches model
  const scriptSys = pc.script.system_instruction;
  assert.ok(scriptSys.includes('Hook 类型库') || pc.director.system_instruction.includes('Hook 类型库'),
    'Hook taxonomy must reach model via director or script system_instruction');
  assert.ok(scriptSys.includes('Shot Task Checklist'),
    'Shot Task Checklist must be in script.system_instruction sent to WF02a');
  assert.ok(scriptSys.includes('复杂产品功能拆解原则'),
    'Complex product breakdown must be in script.system_instruction');

  // Simulate voice arc injection: default.tone → localCreatorTone → videoPrompt
  const defTone = pc.voice_localization.default.tone;
  assert.ok(defTone.includes('emotion arc'),
    'voice arc must be in default.tone (reaches n8n02b localCreatorTone → videoPrompt)');

  // Simulate execution_layer → videoPrompt injection
  const cropCode = wfNodeCode(wf02b, '六宫格裁切_9x16');
  assert.ok(cropCode.includes('execution_layer'),
    'n8n02b must read execution_layer from prompts');
  assert.ok(cropCode.includes("_execProdFn ? 'Product function execution rule:"),
    'execution_layer.product_function_low_risk must appear in final videoPrompt when non-empty');

  // Simulate mock product injection through user_template slots
  function tpl(str, vars) {
    let out = String(str || '');
    for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v ?? '');
    return out;
  }
  const mockVars = { product_name: '__TEST__', product_desc: '', target_market: 'VN',
                     target_language: 'Vietnamese', creative_task_type: '痛点前置',
                     creative_task_type_rules: '{}', reference_case_url: '',
                     product_images_json: '[]', product_consistency_rule: '' };
  const dirText = tpl(pc.director.user_template, mockVars);
  const unresolved = dirText.match(/\{\{[^}]+\}\}/g);
  assert.ok(!unresolved || unresolved.length === 0,
    `All {{slots}} in director.user_template must resolve, found: ${JSON.stringify(unresolved)}`);
  assert.ok(dirText.includes('__TEST__'), 'product_name slot must be injected');

  console.log('PASS [14] P2B runtime assembly preview: Hook/Checklist/Breakdown in sys_instruction, arc in tone, exec_layer in n8n02b code');
}

// ═══ [15] Storyboard differentiation (P2 + P2B retained) ════════════════════
{
  assertBoth('15', (pc, file) => {
    const sbsys = pc.storyboard.system_instruction;
    assert.ok(sbsys.includes('6 首帧信息递进与去同质化约束'),
      `${file}: P2 storyboard differentiation must be retained`);
    assert.ok(sbsys.includes('首帧任务矩阵'), `${file}: P2B panel matrix must be present`);
    assert.ok(sbsys.includes('禁止多个 panel'), `${file}: must prohibit homogeneous panels`);
  });
}

// ═══ [16] Product-reference handoff: all uploaded images + primary identity ══
{
  assertBoth('16 prompts', (pc, file) => {
    for (const [stage, tpl] of [
      ['director', pc.director.user_template],
      ['script', pc.script.user_template],
      ['storyboard', pc.storyboard.user_template],
    ]) {
      assert.ok(tpl.includes('product_images_json'), `${file}: ${stage}.user_template must expose product_images_json`);
      assert.ok(tpl.includes('product_consistency_rule'), `${file}: ${stage}.user_template must expose product_consistency_rule`);
      assert.ok(tpl.includes('白底图') || tpl.includes('primary_product_reference'),
        `${file}: ${stage}.user_template must explain primary/white-background product reference priority`);
    }
    assert.ok(pc.director.system_instruction.includes('产品参考图优先级'),
      `${file}: director system must define product reference priority`);
    assert.ok(pc.script.system_instruction.includes('主产品参考图优先级'),
      `${file}: script system must define product reference priority`);
    assert.ok(pc.storyboard.system_instruction.includes('分镜主产品锁定'),
      `${file}: storyboard system must lock primary product identity`);
  });

  const wf01 = loadWf(N8N01);
  const loadImages = wfNodeCode(wf01, '加载默认测试图片');
  const directorReq = wfNodeCode(wf01, '导演请求体组装');
  const conceptExtract = wfNodeCode(wf01, '创意方向提取');
  const saveConcept = wfNodeCode(wf01, '保存创意方向上下文');
  assert.ok(loadImages.includes('for (let i = 0; i < maxImages; i++)'),
    'WF01 must preserve all uploaded images up to the UI max');
  assert.ok(loadImages.includes('primary_product_reference') && loadImages.includes('supporting_detail_reference'),
    'WF01 must tag primary vs supporting product references');
  assert.ok(directorReq.includes('collectImageParts') && directorReq.includes('product_images_json'),
    'WF01 director request must send dynamic image parts and image metadata');
  assert.ok(conceptExtract.includes('input.product_image_local_paths.length > 0'),
    'WF01 concept extraction must keep a single uploaded image path, not require >=2');
  assert.ok(conceptExtract.includes('directPaths.length > 0'),
    'WF01 concept extraction must keep one image from product_images_meta');
  assert.ok(saveConcept.includes('product_image_count') && saveConcept.includes('product_consistency_rule'),
    'WF01 concept context must retain image count and product consistency rule');

  const wf02a = loadWf(N8N02A);
  const scriptReq = wfNodeCode(wf02a, '脚本请求体组装');
  const scriptSave = wfNodeCode(wf02a, '写脚本框架上下文');
  assert.ok(scriptReq.includes('for (let i = 0; i < imageCount; i++)'),
    'WF02A script request must loop through uploaded images, not hardcode only image_1/image_2');
  assert.ok(scriptReq.includes('product_images_json') && scriptReq.includes('产品一致性硬规则'),
    'WF02A script request must inject product image metadata and identity rules');
  assert.ok(scriptSave.includes('image_5_path') && scriptSave.includes('product_consistency_rule'),
    'WF02A script context must preserve up to five image paths plus product consistency rule');

  const wf02b = loadWf(N8N02B);
  const storyboardReq = wfNodeCode(wf02b, 'Code in JavaScript1');
  const localImages = wfNodeCode(wf02b, '本地图片转Gemini输入');
  const nanoAssemble = wfNodeCode(wf02b, '组装NanoBanana执行字段');
  assert.ok(storyboardReq.includes('for (let i = 0; i < imageCount; i++)'),
    'WF02B storyboard prompt request must loop through uploaded images');
  assert.ok(storyboardReq.includes('product_images_json') && storyboardReq.includes('产品一致性硬规则'),
    'WF02B storyboard prompt request must inject product image metadata and identity rules');
  assert.ok(localImages.includes('fallback_primary_product_reference') &&
            localImages.includes('first_uploaded_reference_fallback'),
    'WF02B image collector must fall back to the first uploaded image when no white-background identity image is detected');
  assert.ok(nanoAssemble.includes('clean_background_identity_reference_count') &&
            nanoAssemble.includes('No clear white-background/product-only reference was detected'),
    'WF02B Nano prompt must distinguish clean product identity refs from fallback primary refs');
  console.log('PASS [16] product-reference handoff: all uploaded images + primary identity');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
console.log('prompt-p2b nonpaid tests: ALL PASS (16/16)');
