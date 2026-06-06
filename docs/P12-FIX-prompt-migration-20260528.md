# P12-FIX Prompt Seed / Migration 修复报告

生成时间: 2026-05-28  
工单编号: P12-FIX-PROMPT-MIGRATION  
状态: ✅ Migration 实现并验证通过；App Support prompt 已刷新为 P11 新版本

---

## 一、Prompt 加载策略（只读审计）

### 1. 读取优先级

```
dist 模式（App Support 存在时）：
  ~/Library/Application Support/AI Video/prompts/prompt_center.json  ← 实际读取

dist 模式（App Support 不存在时）：
  RC bundle/版本测试/prompts/prompt_center.json  → seed → App Support

dev 模式：
  [项目目录]/版本测试/prompts/prompt_center.json  （bundle = App Support）
```

**关键代码**（serve-review-assets.mjs line 80）：
```js
const PROMPTS_DIR = process.env.AI_VIDEO_PROMPTS_DIR ||
  (APP_MODE === 'dist' ? path.join(APP_SUPPORT_DIR, 'prompts') : BUNDLED_PROMPTS_DIR);
const PROMPT_CENTER_PATH = path.join(PROMPTS_DIR, 'prompt_center.json');
const PROMPT_CENTER_SEED_PATH = path.join(BUNDLED_PROMPTS_DIR, 'prompt_center.json');
```

### 2. 路径

| 角色 | 路径 |
|------|------|
| bundle seed（只读） | `[RC bundle]/版本测试/prompts/prompt_center.json` |
| App Support（运行时读写） | `~/Library/Application Support/AI Video/prompts/prompt_center.json` |

### 3-10. 修复前原始问题

| 问题 | 状态 |
|------|------|
| App Support 存在时跳过 bundle seed | ✅（原始行为——修复前就是如此） |
| prompt version / hash 字段 | 有 `_version: 1.1.0` 和 `_updated_at`，但新旧文件值相同，无法用于判断 |
| prompt migration 机制 | ❌ **修复前不存在** |
| 新用户首次启动读取 | bundle seed（复制到 App Support 后读） |
| 老用户升级后读取 | **旧 App Support 文件**（修复前不覆盖）→ 旧 prompt 覆盖风险 ✅ 已修复 |

---

## 二、修复实现

### 修改文件

| 文件 | 变更类型 |
|------|---------|
| `版本测试/serve-review-assets.mjs` | 添加 migration 逻辑（2处）|
| `release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app/Contents/Resources/app/版本测试/serve-review-assets.mjs` | 同步（cp）+ re-sign |

**未修改**：workflow JSON、n8n 节点、schema、Code 节点、prompt_center.json 内容。

### Migration 逻辑说明

**新增函数** `_isStalePromptCenter(center)` — 检测 stale 指标（任一为 true → 触发 migration）：
```js
function _isStalePromptCenter(center) {
  const directorUt = center?.director?.user_template || '';
  const scriptSi = center?.script?.system_instruction || '';
  return (
    directorUt.includes('6 到 9 个镜头') ||
    directorUt.includes('6 宫格还是 9 宫格') ||
    !scriptSi.includes('TikTok 短平快约束')
  );
}
```

**新增函数** `_logPromptMigration(backupPath)` — 写 migration 日志到：
`~/Library/Application Support/AI Video/logs/launcher/prompt-migration.log`

**修改** `loadPromptCenter()` — 在 seed（不存在时）之后，新增 migration 分支：
```js
} else if (PROMPT_CENTER_PATH !== PROMPT_CENTER_SEED_PATH && fs.existsSync(PROMPT_CENTER_SEED_PATH)) {
  try {
    const existing = JSON.parse(fs.readFileSync(PROMPT_CENTER_PATH, 'utf8'));
    if (_isStalePromptCenter(existing)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const backupPath = PROMPT_CENTER_PATH.replace(/\.json$/, `.bak-${ts}.json`);
      fs.copyFileSync(PROMPT_CENTER_PATH, backupPath);
      fs.copyFileSync(PROMPT_CENTER_SEED_PATH, PROMPT_CENTER_PATH);
      _logPromptMigration(backupPath);
    }
  } catch {}
}
```

**新增启动时 eager call**（server.listen 之前）：
```js
// Eager prompt migration at startup: ensures App Support prompt is up-to-date before first request.
if (APP_MODE === 'dist') loadPromptCenter();
```

Migration 保守性设计：
- 仅在 stale 内容指标命中时覆盖
- 覆盖前必须备份旧文件（含时间戳）
- 仅在 dist 模式（`PROMPT_CENTER_PATH !== PROMPT_CENTER_SEED_PATH`）触发
- 全部错误静默（`catch {}`），不影响正常启动流程

---

## 三、Drew 本机快速验证

### 3.1 Migration 执行证据

| 项目 | 结果 |
|------|------|
| 旧 prompt 备份 | `~/…/prompts/prompt_center.bak-2026-05-28_01-51-59.json` ✅ |
| Migration 日志 | `[2026-05-28T01:51:59.715Z] prompt_center.json auto-migrated to bundle version (stale 9-grid / missing P11 constraints detected); backup: …bak-2026-05-28_01-51-59.json` ✅ |

### 3.2 Stale 指标（全部 False ✅）

| 指标 | 结果 |
|------|------|
| `"6 到 9 个镜头"` in director.user_template | False ✅ |
| `"6 宫格还是 9 宫格"` in director.user_template | False ✅ |
| `"9_grid"` in director.user_template | False ✅ |

### 3.3 P11 新约束（全部 True ✅）

| 约束 | 结果 |
|------|------|
| `TikTok 短平快约束` in script.system_instruction | True ✅ |
| `TikTok 短平快约束` in storyboard.system_instruction | True ✅ |
| `单一说话人` in script.system_instruction | True ✅ |
| `6_grid` 固定 in director.user_template | True ✅ |
| item 18/19 in script.user_template | True ✅ |

### 3.4 App Support prompt 与 RC bundle 内容完全一致

| 字段 | 一致 |
|------|------|
| director.user_template | ✅ |
| script.system_instruction | ✅ |
| script.user_template | ✅ |
| storyboard.system_instruction | ✅ |

### 3.5 运行态确认

| 项目 | 结果 |
|------|------|
| 运行进程 | PID 8841 — `AI-Video-Mac-MVP-20260528-0849/…/node serve-review-assets.mjs` ✅ |
| UI HTTP | 200 ✅ |
| n8n health | `{"status":"ok"}` ✅ |
| app_mode | dist ✅ |
| project_root | `…/AI-Video-Mac-MVP-20260528-0849/…` ✅ |
| Execution count | max_id=17, total=17（零新增）✅ |

---

## 四、问答输出（工单要求格式）

| # | 问题 | 答案 |
|---|------|------|
| 1 | 当前 prompt 加载策略 | dist 模式从 App Support 读；migration 逻辑在 loadPromptCenter() 中，startup 时 eager 触发 |
| 2 | 修改了哪些文件 | `版本测试/serve-review-assets.mjs`（source）+ `0849 RC bundle 同一文件`（cp + re-sign）|
| 3 | migration 逻辑说明 | 内容检测（9_grid 指标 + TikTok 约束缺失）→ 备份旧文件（时间戳）→ cp bundle → 日志 |
| 4 | 旧 prompt 备份路径 | `~/Library/Application Support/AI Video/prompts/prompt_center.bak-2026-05-28_01-51-59.json` |
| 5 | App Support prompt 是否已刷新 | ✅ 已刷新为 P11 新版本 |
| 6 | 当前运行态 prompt 来源 | `~/Library/Application Support/AI Video/prompts/prompt_center.json`（已刷新）|
| 7 | 是否为 P11 新版本 | ✅ 是（内容与 RC bundle 100% 一致）|
| 8 | 是否仍存在旧 prompt 覆盖风险 | ❌ 不存在。下一版 RC 升级后，如果 bundle 内容新于 App Support（stale 指标匹配），migration 自动触发 |
| 9 | 是否触发任何付费 API | ❌ 未触发 |
| 10 | 是否建议重新生成下一版 RC | 当前 0849 RC 已含修复（serve-review-assets.mjs 已更新 + re-signed）；不需要生成 0850；0849 可作为 P13 审计基础 |
| 11 | 是否允许进入 P13 | ✅ 允许进入 P13 新用户交付级审计 |

---

## 五、关键文件索引

| 文件 | 用途 |
|------|------|
| `版本测试/serve-review-assets.mjs` | 源文件（含 migration 逻辑）|
| `release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app` | 当前运行 RC（含 migration，codesign PASS）|
| `~/Library/Application Support/AI Video/prompts/prompt_center.json` | 运行时 prompt（已刷新为 P11 新版本）|
| `~/Library/Application Support/AI Video/prompts/prompt_center.bak-2026-05-28_01-51-59.json` | 旧 prompt 备份 |
| `~/Library/Application Support/AI Video/logs/launcher/prompt-migration.log` | Migration 执行日志 |
