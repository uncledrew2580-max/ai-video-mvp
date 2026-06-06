# CURRENT_RUNTIME.md

> 生成于 2026-05-18 | 更新于 2026-05-19（第五轮收口）| 工程执行：Claude | 审计：Codex

---

## 1. 客户端入口

| 层级 | 路径 | 说明 |
|------|------|------|
| **用户入口** | `dist/AI Video.app/.../client/mac/TikTok AI 视频工作台.command` | 双击启动；设 `REVIEW_ASSET_PORT=18788` 后调用 `node client/launcher.mjs` |
| 启动器 | `client/launcher.mjs` | 管理端口检查、n8n 子进程、UI 子进程、健康检查、浏览器打开 |
| n8n 端口 | `5678` | n8n 工作流引擎（`N8N_USER_FOLDER=.n8n-local-cache` 或全局 `~/.n8n`） |
| **dist 客户端 UI 端口** | `18788` | dist .command 注入 `REVIEW_ASSET_PORT=18788`；用户访问 `http://127.0.0.1:18788` |
| source 开发 UI 端口 | `8788` | 开发者：`node 版本测试/serve-review-assets.mjs`；**用户不使用此端口** |

---

## 2. UI 服务入口（工作台）

- **脚本**: `版本测试/serve-review-assets.mjs`（source）或 `dist/.../版本测试/serve-review-assets.mjs`（dist）
- **端口**: `process.env.REVIEW_ASSET_PORT || 8788`（dist 客户端设为 18788，source 默认 8788）
- **配置路径**: `SCRIPT_DIR/config/local-config.json`（运行哪个版本就读哪个 config，二者互相独立）
- **配置保存**: `POST /config-save` → 写回当前运行的 config（同上规则）
- **项目数据路径**: `WORKFLOW_DATA_ROOT/.n8n-local-cache/`（concept-context、project-state 等）
  - `WORKFLOW_DATA_ROOT` = `process.env.WORKFLOW_DATA_ROOT`（launcher 注入）或 `PROJECT_ROOT`（直接运行时）
  - 外部 n8n 复用时，launcher 把 `WORKFLOW_DATA_ROOT` 设为 `~/Downloads/tiktok-n8n-workflow-pack`（n8n 实际写入路径）
- **API Key 验证**: `POST /test-connection` → 调用 `https://api.kie.ai/api/v1/veo/record-info?taskId=test-ping`（code ≠ 401/403 即通过）

---

## 3. n8n Active Workflows（当前 DB 状态）

| active | ID | 名称 | 源文件 |
|--------|----|------|--------|
| ✅ 1 | `rKHHjD2QBlL6EhaM` | TikTok主流程｜表单→创意方向 | `正式导入文件/iteration-v1/n8n01.json` |
| ❌ 0 | `conceptSelectStoryboardV1` | TikTok续跑｜创意方向选择→脚本分镜 | `正式导入文件/iteration-v1/n8n02.json` |
| ✅ 1 | `scriptGenerateV1` | TikTok续跑｜创意确认→脚本框架 | `正式导入文件/iteration-v1/n8n02a.json` |
| ✅ 1 | `storyboardGenerateV1` | TikTok续跑｜脚本确认→分镜图生成 | `正式导入文件/iteration-v1/n8n02b.json` |
| ✅ 1 | `reviewSubmitVeoV2` | TikTok续跑｜分镜审核→视频生成 | `正式导入文件/iteration-v1/n8n03.json` |

> `conceptSelectStoryboardV1` (WF02) 为已废弃的旧版合并流程，保留 inactive，不影响运行。

---

## 4. 配置文件路径与层级

### 主配置（单一来源，唯一写入点）

```
版本测试/config/local-config.json          ← 工作台 UI 写入，n8n Code 节点读取
版本测试/config/local-config.example.json  ← 空值模板（不含密钥）
```

### Dist 副本（脚本同步）

```
dist/AI Video.app/Contents/Resources/app/版本测试/config/local-config.json
```

**同步命令**（默认：保留 dist 已有 api_key，只更新代码/模型配置）：
```bash
bash scripts/sync-to-dist-app.sh
```

**公开分发包**（清除所有 api_key）：
```bash
bash scripts/sync-to-dist-app.sh --redact-key
```

**显式覆盖 dist key**（仅开发者手动操作后使用）：
```bash
bash scripts/sync-to-dist-app.sh --overwrite-key
```

> sync 默认行为：读取 dist 现有 api_key → 合并到新配置 → 写入 dist。用户通过 8788 UI 保存的 key 不会被 sync 覆盖。
> 上次同步：2026-05-19（第三轮收口）。

### 旧版 / 废弃（已移入 archive-disabled/）

```
archive-disabled/TikTok-AI-Video-Workbench-mac-mvp/
  → 原 dist/TikTok-AI-Video-Workbench-mac-mvp/，已归档
  → 含旧 text_model: gemini-2.5-flash，勿使用
```

### n8n Code 节点读取路径（所有 WF 统一）

```javascript
// readApiConfig() / readKieKey() 优先路径顺序：
1. ~/Downloads/tiktok-n8n-workflow-pack/版本测试/config/local-config.json
2. <PROJECT_ROOT>/版本测试/config/local-config.json（fallback，同一文件）
```

---

## 5. 配置链路（API Key 单入口）

```
用户在 http://127.0.0.1:8788 填写 Kie API Key
        ↓ POST /config-save
版本测试/config/local-config.json  (.kie.api_key)
        ↓ n8n Code 节点 readKieKey() / readApiConfig()
$json._api_url    = https://api.kie.ai/gemini-3.1-pro-openai/v1/chat/completions
$json._auth_header = Bearer <api_key>
$json._image_url  = https://api.kie.ai/api
        ↓ HTTP Request 节点
Kie AI API
```

**使用 `_api_url` / `_auth_header` 的节点（全部 active WF）：**

| WF | 节点名 |
|----|--------|
| WF01 | `创意方向生成`、`创意方向精炼`、`创意方向最终选择` |
| WF02a | `脚本框架生成` |
| WF02b | `分镜图提示词生成`（文本）；`storyboard image`（图像，kie_market_image） |
| WF03 | `Veo失败提示词生成` |

---

## 6. API Key 更换操作流程

> serve-review-assets.mjs 运行于哪个目录，`/config-save` 就写哪个目录的 config（`SCRIPT_DIR/config/local-config.json`）。用户只需在正在运行的 8788 UI 填写一次。

**通用流程（source 或 dist app 均适用）：**
```
① 打开正在运行的 http://127.0.0.1:8788
   → 系统配置页 → 填写 Kie API Key → 点击「保存配置」
   → 立即生效，无需重启

② （开发者）若需同步代码/模型更新到 dist，执行：
   bash scripts/sync-to-dist-app.sh
   → 默认保留 dist 中已保存的 api_key，不会覆盖
```

**注意**：直接运行 sync 脚本不会更改任何一端的 api_key（除非加 `--overwrite-key`）。

---

## 7. 输出目录

| 类型 | 路径 |
|------|------|
| 分镜图裁剪 | `~/Downloads/n8n分镜图裁剪/` |
| 生成视频 | `~/Downloads/n8n视频/` |

---

## 8. Prompt 中心

- **n8n 运行时读取**: `prompts/prompt_center.json`（**根目录**，v1.1.0）
  - n8n Code 节点 `projectRoot()` = `$PROJECT_ROOT` env = 项目根目录
  - launcher 启动 n8n 时注入 `PROJECT_ROOT` 环境变量指向项目根
- **UI 配置副本**: `版本测试/prompts/prompt_center.json`（同版本，UI 同步用）
- **结构**: `prompt_stages` 包含 5 个阶段：`creative_direction`、`script_framework`、`storyboard_image`、`veo_video`、`error_repair`
- **同步说明**: 修改 prompt 后须同时更新根目录和 `版本测试/prompts/` 两个副本，或运行 `bash scripts/sync-to-dist-app.sh`

---

## 9. 目录用途分类

### ✅ 活跃（勿删）

```
版本测试/                      工作台 UI + 配置 + prompt（UI 副本）
prompts/                       n8n 运行时读取的 prompt_center.json（勿删！）
正式导入文件/iteration-v1/     5 个 workflow 的单一来源（canonical）
client/                        launcher + mac 启动脚本
docs/                          工程文档
scripts/                       bootstrap + dist 同步脚本
dist/AI Video.app/             分发包（由 scripts/sync-to-dist-app.sh 同步）
不要导入-历史备份/             已有旧备份，勿删
```

### ✅ 已移入 archive-disabled/（第二轮收口，2026-05-18）

```
archive-disabled/TikTok-AI-Video-Workbench-mac-mvp/  ← 原 dist/mvp

根目录旧 JSON（38 项）：
  concept-select-workflow.json + .backup-* (×3)
  review-submit-workflow.json
  版本迭代使用.json + .backup-* (×5)
  wavespeed-vidu-test-workflow.json
  tiktok短视频工作流_improved.json + .backup-* (×3)
  tiktok短视频工作流_副本.json
  tiktok-workflow-prompts.json

patch 脚本 (已应用，归档)：
  patch_fix_image_mime_detection.mjs, patch_fix_uploaded_binary_read.mjs,
  patch_gemini_text_helper.mjs, patch_http_request_nodes.mjs,
  patch_nano_checkpoint.mjs, patch_p0_hardcoded.py, patch_robust_llm_json_extract.mjs

旧 sync 脚本（已被 sync_iteration_v1_workflows_to_db.mjs 替代）：
  sync_bundle/concept_select/review_submit/wavespeed/wf02ab/workflow_to_db.mjs

旧 build/migrate/TTS 脚本：
  build-concept-select-workflow.mjs, build-tiktok-n8n-workflow.mjs,
  build_wf02_split.py, migrate_review_workflow_to_wavespeed.mjs,
  tts_edge_generate.py, voiceover_localize.mjs, gemini-generate.mjs

  serve-review-assets.ROOT-OLD.mjs  ← 原根目录旧版 serve 脚本（3688 行）
```

### ⚠️ 根目录保留（不动）

```
prompts/          ← WF01 Prompt Library 实际读取路径，勿归档！
config/           ← creative_task_type_mapping.json 在 workflow meta 中引用，保留
veo-download.mjs, veo-sdk-submit.mjs, veo-status.mjs  ← 独立 CLI 工具，不影响 runtime
repair_active_workflow_versions.mjs, stability_check.mjs  ← 运维工具
export_project_prompt_doc.py, prompt-module-loader.mjs    ← 开发工具
```

---

## 10. 当前已知风险

| 风险 | 严重度 | 说明 |
|------|--------|------|
| Kie 文本模型端点 ✅ 已修复 | INFO | 正确端点：`POST https://api.kie.ai/gemini-3.1-pro-openai/v1/chat/completions`。端点可达；dist config 已有新 key `0187...`，填写后即可通过。 |
| source 8788 与 dist 18788 混用 ✅ 已修复 | INFO | launcher 检测到 source 8788 在跑时输出警告。`WORKFLOW_DATA_ROOT` 与 `PROJECT_ROOT` 拆分，dist app 现在使用自己的 config 路径（`SCRIPT_DIR/config/`），数据路径跟随 n8n 实际写入位置。 |
| normalizeAssetUrl 端口硬编码 ✅ 已修复 | INFO | 原先将 8787→8788 固定写死，dist 18788 下资产 URL 会指向错误端口。现已改为 `PORT`（运行时值）。 |
| n8n Code 节点路径硬编码 ✅ 已修复 | INFO | 原先固定用 `os.homedir()/Downloads/tiktok-n8n-workflow-pack`，现改为 `process.env.TIKTOK_WORKFLOW_ROOT \|\| process.env.PROJECT_ROOT \|\| homedir fallback`。dist 启动自己的 n8n 时 Code 节点写入 dist 数据目录。 |
| sync-to-dist-app.sh ✅ 已修复 | INFO | 默认保留 dist api_key；`--overwrite-key` 显式覆盖；`--redact-key` 清零用于公开分发。 |
| dist .command 未设端口 ✅ 已修复 | INFO | dist `.command` 现在 `export REVIEW_ASSET_PORT=18788`，dist 客户端固定 18788，与 source 8788 完全隔离。sync 脚本不复制 .command，需手动维护。 |
| Config + Prompt 路径（换机风险） | LOW | 若项目目录移出 `~/Downloads/tiktok-n8n-workflow-pack`，需更新 `PROJECT_ROOT` 环境注入。 |
| dist/mvp 已归档 | INFO | `dist/TikTok-AI-Video-Workbench-mac-mvp/` 已移入 `archive-disabled/`，不再有误用风险 |
| WF02 (inactive) 保留 | INFO | `conceptSelectStoryboardV1` inactive，不影响流程，可随时删除 |

---

## 11. 当前是否可测试

> **用户测试入口**：双击 `dist/AI Video.app/.../client/mac/TikTok AI 视频工作台.command` → 浏览器自动打开 `http://127.0.0.1:18788`。
> 开发者调试可直接访问 `http://127.0.0.1:8788`（source 服务需单独启动，不是用户路径）。

| 功能 | 状态 | 条件 |
|------|------|------|
| 工作台 UI 打开 (18788 dist) | ✅ 可测 | 双击 dist `.command`（已设 `REVIEW_ASSET_PORT=18788`） |
| API Key 验证按钮 | ✅ 可测 | 有效 Kie API Key 即可（Veo 端点验证） |
| 分镜图生成 (WF02b) | ✅ 可测 | Kie image API 正常，此 API Key 有效 |
| 视频提交 (WF03) | ✅ 可测 | Veo API 有效 |
| 创意方向生成 (WF01) | ⚠️ 待验证 | 端点已升级为 `gemini-3.1-pro-openai`；需新 API Key 填写后测试 |
| 脚本框架生成 (WF02a) | ⚠️ 待验证 | 同上 |
