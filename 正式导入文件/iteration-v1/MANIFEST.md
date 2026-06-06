# Iteration-v1 主线工作流清单

生成时间: 2026-05-10  
更新时间: 2026-05-14（WF02 拆分为 WF02A + WF02B，阶段闸门式流水线）  
状态: 已验证 ✅

---

## 主线文件（当前生产版本）

| 编号 | 文件名 | Workflow ID | 节点数 | 说明 |
|------|--------|-------------|--------|------|
| WF01 | `n8n01.json` | `rKHHjD2QBlL6EhaM` | 36 | 表单 → 创意方向生成 |
| WF02A | `n8n02a.json` | `scriptGenerateV1` | 12 | 创意确认 → Gemini 脚本框架 → script_context.json → 停止 |
| WF02B | `n8n02b.json` | `storyboardGenerateV1` | 18 | 脚本确认 → NanoBanana 分镜图 → review_context.json → 停止 |
| WF03 | `n8n03.json` | `reviewSubmitVeoV2` | 30 | 分镜审核 → ModelHub Veo 视频生成 |

### 已停用（被 WF02A/WF02B 取代）
| 文件名 | Workflow ID | 状态 |
|--------|-------------|------|
| `n8n02.json` | `conceptSelectStoryboardV1` | ❌ DB 中已设 active=0，不再自动注册 webhook |

### 阶段闸门式流水线说明

```
WF01 表单 → 创意方向生成 → 用户选择创意方向
  → POST /concept-select → WF02A webhook (storyboard-concept-select-v1)
  → WF02A 生成脚本框架 → 写 script_context_{project_id}.json → 停止

用户访问 /script-review?project_id=xxx → 审核/编辑各镜头字段
  → POST /script-shot-save → 保存 script_user_overrides_{project_id}.json（不触发生成）
  → POST /script-confirm → 标记旧 review_context 为 .stale → 触发 WF02B webhook (storyboard-generate-v1)

WF02B 读取 script_context.json + user_overrides → NanoBanana 分镜图
  → 写 review_context_{project_id}_{round}_{ts}.json → 停止

用户访问 /reviews/item?... → 审核分镜图 → POST /review-submit → WF03 → 视频生成
```

---

## 同步到 n8n DB 的命令

### ✅ WF01 + WF03（三件套脚本，含硬校验）

```bash
node sync_iteration_v1_workflows_to_db.mjs
```

脚本行为：同步 WF01/WF02(旧)/WF03，含硬校验。  
注意：WF02 旧版（`conceptSelectStoryboardV1`）被设为 active=0，不会导致 webhook 冲突。

### ✅ WF02A + WF02B（阶段闸门拆分版）

```bash
node sync_wf02ab_to_db.mjs
```

脚本位置：`sync_wf02ab_to_db.mjs`（项目根目录）  
脚本行为：
- 读取 `n8n02a.json`（scriptGenerateV1）和 `n8n02b.json`（storyboardGenerateV1）
- 校验：WF02A 含 `写脚本框架上下文` 节点，WF02B 无旧引用（提取脚本框架JSON/Nano前_轻量上下文），含 `$('读取脚本上下文')` 引用
- 校验失败则抛出错误，拒绝写入

### ❌ 禁止使用的方式

```bash
# 禁止：会覆盖 modelhub 版 WF03
node sync_bundle_workflows_to_db.mjs

# 禁止：不处理 WF02A/WF02B
node sync_review_submit_workflow_to_db.mjs
```

---

## 验证命令（每次同步后必跑）

```bash
# JSON 格式有效
python3 -c "import json; [json.load(open(f)) for f in [
  '正式导入文件/iteration-v1/n8n01.json',
  '正式导入文件/iteration-v1/n8n02.json',
  '正式导入文件/iteration-v1/n8n03.json'
]]; print('JSON OK')"

# 无 /Users/drew 硬编码路径
grep -l '/Users/drew' 正式导入文件/iteration-v1/*.json && echo '❌ 路径泄露' || echo '✅ 无硬编码路径'

# 无 Gemini API Key
grep -l 'AIzaSy' 正式导入文件/iteration-v1/*.json && echo '❌ Key 泄露' || echo '✅ 无 Gemini Key'

# WF03 文件内容校验
python3 -c "
import json
wf = json.load(open('正式导入文件/iteration-v1/n8n03.json'))
raw = json.dumps(wf)
checks = {
  'scene-audio=False': 'scene-audio' not in raw,
  'tts_edge_generate=False': 'tts_edge_generate' not in raw,
  'synthesizeVoiceover=False': 'synthesizeVoiceover' not in raw,
  'mergeWithAudio=False': 'mergeWithAudio' not in raw,
  'raw-scene-videos=False': 'raw-scene-videos' not in raw,
  'modelhub=True': 'modelhub' in raw,
  'veo3.1-fast=True': 'veo3.1-fast' in raw,
}
for k, v in checks.items():
  print(('✅' if v else '❌') + ' ' + k)
"

# Active DB 验证（同步后）
sqlite3 ~/.n8n/database.sqlite "
SELECT
  id,
  CASE WHEN nodes LIKE '%scene-audio%' THEN '❌ has scene-audio' ELSE '✅ no scene-audio' END,
  CASE WHEN nodes LIKE '%modelhub%' THEN '✅ has modelhub' ELSE '❌ no modelhub' END,
  CASE WHEN nodes LIKE '%veo3.1-fast%' THEN '✅ has veo3.1-fast' ELSE '❌ no veo3.1-fast' END
FROM workflow_entity
WHERE id IN ('rKHHjD2QBlL6EhaM', 'conceptSelectStoryboardV1', 'reviewSubmitVeoV2');"
```

---

## 新增产品化能力（本版本）

### UI 配置层（已接入导入 JSON，未 sync DB）
| 新增文件 | 用途 |
|----------|------|
| `config/local-config.example.json` | 配置模板 |
| `config/local-config.json` | 运行时配置（API Key 路径、模型 ID、目录等） |
| 8788 `/config` 页面 | 系统配置 UI，API Key 只显示是否已配置，不回显明文 |

### 提示词中心（已接入导入 JSON，未 sync DB）
| 新增文件 | 用途 |
|----------|------|
| `prompts/prompt_center.json` | 运行时可编辑提示词（从 tiktok-workflow-prompts.json 提取） |
| `prompts/prompt_center.example.json` | 只读默认备份，用于"恢复默认" |
| 8788 `/prompt-center` 页面 | 5个模块 + Gemini 模型配置，支持编辑/保存/恢复默认 |

### Workflow 运行时读取
- `n8n01.json` / `n8n02.json` 的 `Prompt Library` 节点已改为运行时读取 `prompts/prompt_center.json`。
- `Prompt Library` 会优先使用 `TIKTOK_WORKFLOW_ROOT` / `PROJECT_ROOT`，否则回退到 `process.cwd()`。
- 如果 `prompt_center.json` 缺少 `storyboard_grid` 或 `creative_task_type_mapping`，会从 `tiktok-workflow-prompts.json` 或内置最小默认值补齐，避免裁切和任务类型映射断链。
- `n8n03.json` 的 `Veo失败提示词请求体` 已改为读取 `prompts/prompt_center.json` 中的 `veo_repair`。
- `n8n03.json` 的 ModelHub Key 和视频模型默认值已优先读取 `config/local-config.json` 的 `modelhub_api_key_file` / `modelhub_video_model`。

### 首页双模式入口
- "直接开始" → n8n 表单（使用默认提示词）
- "自定义提示词后开始" → 提示词中心，保存后填表单

### 迁移待办（后续执行）
- [x] 导入 JSON 中 Prompt Library 节点改为读取 `prompts/prompt_center.json`
- [x] 导入 JSON 中 WF03 ModelHub Key / video model 优先读取 `config/local-config.json`
- [ ] sync DB 后在 n8n 内部 workflow 实例验证运行时读取逻辑
- [ ] Gemini 文本/图像模型 ID 进一步统一读取 `config/local-config.json`

---

## 端口统一：8788（迁移完成 ✅ 2026-05-11）

> 唯一入口：`http://127.0.0.1:8788/`。8787 已废弃，服务已停，不做 fallback/redirect。

### 已完成的变更

| 位置 | 变更 |
|------|------|
| `版本测试/serve-review-assets.mjs` | PORT=8788，无任何 8787 引用 |
| `正式导入文件/iteration-v1/n8n01.json` | formTrigger `redirectUrl` → 8788；JS 代码中 `reviewAssetBaseUrl` → 8788 |
| `正式导入文件/iteration-v1/n8n02.json` | `reviewAssetBaseUrl` → 8788 |
| active n8n DB（WF01/WF02/WF03） | 直接更新 nodes，全部 127.0.0.1:8787 → 8788；备份在 `版本测试/backups/` |
| `prompts/prompt_center.json` | `_comment` 中 8787 → 8788 |
| `版本测试/prompts/prompt_center.json` | 同上 |
| `版本测试/concept-select-workflow.json` | 8787 → 8788 |
| `正式导入文件/iteration-v1/MANIFEST.md` | 本文件端口引用全部更新 |

### 仍含 8787 的文件（历史残留，不参与当前运行）

以下文件含 8787 但**不在 1.0 运行路径**，不影响当前使用，无需清理：

| 文件 | 性质 | 说明 |
|------|------|------|
| `版本迭代使用.json` | 旧 bundle | 历史源文件，不要导入 |
| `版本迭代使用.backup-*.json` | 旧备份 | 同上 |
| `不要导入-历史备份/` | 旧备份 | 文件夹名已标注"不要导入" |
| `版本测试/backups/wf0*_before_8787fix_*.json` | 本次操作备份 | 升级前快照，仅用于回滚 |
| `正式导入文件/01-*.json`, `02-*.json` | 旧正式文件 | iteration-v1 之前的版本，已由 iteration-v1 替代 |
| `版本测试/正式导入文件/` | 旧镜像 | 版本测试目录下的旧副本 |
| `build-*.mjs`, `stability_check.mjs` | 旧构建工具 | 生成旧 workflow JSON 用，不影响已同步 DB |
| `serve-review-assets.mjs`（根目录） | 旧服务器 | 已由 `版本测试/serve-review-assets.mjs` 取代 |
| `agent-work-orders/`, `docs/` | 历史文档 | 审计报告，仅供参考 |
| `.n8n-local-cache/review-context/*.json` | 运行时缓存 | 旧项目生成时写入，panel_preview_url 含 8787（图片服务已停，图片会显示为 broken，重新跑项目后自动更新） |

---

## 关键约束

- **版本迭代使用.json** 的 WF03 是旧 TTS 版 — 永远不要用它同步 WF03
- **review-submit-workflow.json** 是 WF03 的唯一可信来源（ModelHub + veo3.1-fast，无音频）
- **sync_bundle_workflows_to_db.mjs** 当前状态下禁止用于 iteration-v1 同步（未支持 --file，且 bundle 含旧 WF03）
- **proj_1778356402623** 已污染（旧 TTS WF03 跑出），不用于验收
- **proj_1778321675072** 旧项目，不用于验收
- 验收项目: **proj_1778357441002**（WF01✅ WF02✅ WF03 待确认）
