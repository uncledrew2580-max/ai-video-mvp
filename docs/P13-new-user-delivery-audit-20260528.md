# P13 Mac 新用户交付级验证报告 — AI-Video-Mac-MVP-20260528-0849

生成时间: 2026-05-28  
工单编号: P13-NEW-USER-DELIVERY-AUDIT  
审计模式: 只读  
候选包: `release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app`

---

## P12-FIX 补记（Codex Review 要求）

本报告基于 P12-FIX + P12-FIX-REWORK 已通过的基础上进行审计。当前 `_isStalePromptCenter()` 已包含以下四个 stale 判定条件，P12-FIX-prompt-migration-20260528.md 旧报告仅记录了前三条：

1. `director.user_template` 含 `"6 到 9 个镜头"` → 9-grid 旧文案
2. `director.user_template` 含 `"6 宫格还是 9 宫格"` → 9-grid 旧文案
3. `script.system_instruction` 不含 `"TikTok 短平快约束"` → P11 TikTok 短平快缺失
4. `script.system_instruction` 不含 `"口播者一致性约束"` → **P12-FIX-REWORK 新增**，P11 口播者约束缺失

后续追溯时请以本文件第 4 条为准，不以旧报告口径为准。

---

## P13 总体判断

**✅ 可发第一批 Mac 新用户内测（有条件）**

核心运行隔离、数据隔离、API Key 安全、进程生命周期、工作流同步均已实现。存在几个延后修复项，不影响第一批内测交付。无硬阻塞项。

---

## 12 模块逐项审计

---

### 模块 1：App Bundle 结构

**结论：✅ 通过**

| 项目 | 结果 |
|------|------|
| 自带 Node runtime | `bin/node` v24.14.0 (229MB) ✅ |
| 自带 n8n | `node_modules/n8n/` (28MB) ✅ |
| node_modules 总计 | 2.4G ✅ |
| Workflow JSON 模板 | `正式导入文件/iteration-v1/n8n01/02a/02b/03.json` ✅ |
| Prompt seed | `版本测试/prompts/prompt_center.json` + `.example.json` ✅ |
| Config seed | `版本测试/config/local-config.json`（全部 api_key 为空）✅ |
| Bundle 内 SQLite DB | **无** ✅ |
| Bundle 内 mp4/jpg 旧媒体 | **无** ✅ |
| Bundle 内 `.n8n` 旧数据 | **无** ✅ |

**/Users/drew 路径分析**：

| 文件 | 用途 | 风险 |
|------|------|------|
| `sync_iteration_v1_workflows_to_db.mjs:94` | 拒绝同步的 validation guard | 无运行风险 ✅ |
| `scripts/bootstrap-ai-video-workflows.mjs:63` | 同上 | 无运行风险 ✅ |
| `scripts/check-path-isolation.mjs:6` | 审计脚本注释 | 无运行风险 ✅ |
| `node_modules` build metadata（48 个 .mk/.gypi/.o.d 文件）| P8-D 已记录，非运行代码 | 低风险 ✅ |

**证据路径**：`bin/node`, `node_modules/n8n/`, `正式导入文件/iteration-v1/`, `版本测试/prompts/`, `版本测试/config/`  
**必须修复**：无  
**可延后**：node_modules build metadata 中的 /Users/drew（干净环境 rebuild 可消除，P8-D 已记录）

---

### 模块 2：Node Runtime 隔离

**结论：✅ 通过（有条件降级）**

`desktop/main.cjs` `findNode()` 优先检查 bundled `bin/node`，存在则直接使用：

```js
const bundledNode = path.join(PROJECT_ROOT, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
if (bundledNode && require('node:fs').existsSync(bundledNode)) return bundledNode;
```

n8n 启动时 PATH 环境变量前置 `bin/` 目录：
```js
PATH: [join(PROJECT_ROOT, 'bin'), process.env.PATH || ''].filter(Boolean).join(':')
```

**降级路径**：如果 `bin/node` 不存在（理论上不会，但 codesign 破坏或用户误删时），会降级到系统 node (`/opt/homebrew/bin`, `/usr/local/bin`)，届时给出错误框。

**证据路径**：`desktop/main.cjs:21-47`, `client/launcher.mjs:347`  
**必须修复**：无  
**可延后**：bundled node 缺失时的中文错误提示可更友好

---

### 模块 3：n8n Runtime 隔离

**结论：✅ 通过（非阻塞 warning）**

`client/launcher.mjs` `findN8n()` 按序搜索：
1. `node_modules/n8n/bin/n8n`（bundle 内）✅ → 实际路径存在
2. `node_modules/.bin/n8n`（symlink）
3. `which n8n`（PATH）
4. `~/.npm-global/bin/n8n`

n8n 运行参数：
```js
N8N_USER_FOLDER: ~/Library/Application Support/AI Video/n8n-user
N8N_HOST: '127.0.0.1'
N8N_LISTEN_ADDRESS: '127.0.0.1'   // localhost only, no external exposure
N8N_DISABLE_UI: 'true'             // n8n UI 不暴露给用户
```

**全新 Mac 无系统 n8n**：使用 bundled n8n，`N8N_USER_FOLDER` 独立隔离，不污染用户 `~/.n8n` ✅  
**用户已有全局 n8n**：bundle 内 n8n 优先 → 不冲突 ✅  
**n8n DB**：`~/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite` ✅

**非阻塞 Warning**（n8n.log 中重复 42 次）：
```
Failed to start Python task runner in internal mode...
[runner:js] Allowlisted module 'image-edit-tools' is not installed...
```
当前 WF01-WF03 业务链路不使用 Python runner 或 image-edit-tools，不阻塞运行。但日志噪声可能让技术型新用户困惑。

**证据路径**：`client/launcher.mjs:165-180, 336-389`, `~/Library/Application Support/AI Video/logs/launcher/n8n.log`  
**必须修复**：无  
**可延后**：suppress Python runner / image-edit-tools warning 或在 UI 状态页注明属正常非阻塞 warning

---

### 模块 4：独立数据目录

**结论：✅ 通过**

所有运行时数据均写入 `~/Library/Application Support/AI Video/`（dist 模式）：

| 数据类型 | 路径 | 状态 |
|---------|------|------|
| n8n DB | `n8n-user/.n8n/database.sqlite` | ✅ |
| workflow-data（Code 节点写入）| `workflow-data/` | ✅ |
| 所有 context JSON | `workflow-data/.n8n-local-cache/*/` | ✅ |
| panel/分镜图 | `workflow-data/.n8n-local-cache/分镜图裁剪/` | ✅ |
| 视频输出 | `workflow-data/.n8n-local-cache/videos/` | ✅ |
| final-video | `workflow-data/.n8n-local-cache/final-video/` | ✅ |
| 日志 | `logs/launcher/` | ✅ |
| API Key 配置 | `config/local-config.json` | ✅ |
| Prompt runtime | `prompts/prompt_center.json`（含 P11 migration）| ✅ |

App Support 当前目录确认存在：`config/`, `logs/`, `n8n-user/`, `prompts/`, `workflow-data/`

不写入 bundle 只读目录 ✅  
不写入 /Users/drew 固定路径（除 migration 逻辑外均通过 os.homedir() 动态解析）✅

**证据路径**：`版本测试/serve-review-assets.mjs:20-65`, `client/launcher.mjs:23-31`  
**必须修复**：无  
**可延后**：无

---

### 模块 5：动态端口管理

**结论：⚠️ 风险（可接受，有中文错误提示）**

| 场景 | 行为 | 质量 |
|------|------|------|
| 端口空闲 | 正常启动 | ✅ |
| 5678 被本 App 旧进程占用（healthz 通过）| 复用 | ✅ |
| 5678 被本 App 旧进程占用（healthz 失败）| kill 旧进程 → 重启 | ✅ |
| 5678 被外部程序占用 | exit(1) + 中文提示 | ✅ |
| 18788 被本 App 同实例占用（/health/meta 验证通过）| 复用 | ✅ |
| 18788 被外部程序占用 | exit(1) + 中文提示 | ✅ |
| Runner broker 5679 被外部程序占用 | exit(1) + 中文提示 | ✅ |

**固定端口，无动态 fallback**：默认 n8n=5678, UI=18788，无自动寻找备用端口机制。端口占用时给出明确错误提示，要求用户手动解决。

错误示例：
> `端口 5678 已被其他程序占用，AI Video 未清理该进程。请关闭占用端口 5678 的程序或重启电脑后再打开 AI Video。`

**风险评估**：对第一批内测用户（技术背景明确），可接受。正式发版时建议增加动态端口选择或更友好的引导。

不误杀外部进程（`isPortOwnedByCurrentApp` 通过 `getProcessCommand` 比较 PROJECT_ROOT / APP_SUPPORT_DIR）✅

**证据路径**：`client/launcher.mjs:33-37, 111-137, 483-548`  
**必须修复**：无  
**可延后**：端口冲突时动态寻找备用端口；更详细的端口占用诊断 UI

---

### 模块 6：Workflow Sync

**结论：✅ 通过**

**启动时 workflow 初始化序列**（`client/launcher.mjs:560-590`）：
1. 启动 n8n（创建并迁移 DB schema）
2. 停止 n8n（避免 SQLite 锁）
3. 运行 `bootstrap-ai-video-workflows.mjs`（写入 4 个标准 workflow）
4. 运行 `sync_iteration_v1_workflows_to_db.mjs`（同步最新 JSON 版本）
5. 重新启动 n8n（含 watchdog）

**bootstrap 安全检查**：
- DB 不存在 → 错误退出（n8n 先跑建 DB）✅
- schema 未 ready → 错误退出 ✅
- personal project 不存在 → 错误退出 ✅
- workflow JSON 含 `/Users/drew` → 抛出异常拒绝同步 ✅

**webhook URL patching**（`patchFormTriggerUrl`）：Form Trigger redirect URL 动态写入当前 `WORKSPACE_HOST`（18788）✅

**upsert 逻辑**：nodes + connections + active 均相同时跳过更新（不重复写）；不同时更新并写入 workflow_history ✅

**sqlite3 依赖**：使用系统 `/usr/bin/sqlite3`（macOS 预装）✅

**证据路径**：`client/launcher.mjs:560-590`, `scripts/bootstrap-ai-video-workflows.mjs:80-235`, `sync_iteration_v1_workflows_to_db.mjs`  
**必须修复**：无  
**可延后**：bootstrap 失败时 UI 层面的重试提示（当前只有日志路径错误提示）

---

### 模块 7：Active Guard

**结论：✅ 通过**

**当前 DB 状态**：
| workflow id | name | active | has_active_version |
|-------------|------|--------|-------------------|
| `rKHHjD2QBlL6EhaM` | WF01 表单→创意方向 | **1** | ✅ |
| `scriptGenerateV1` | WF02a 创意确认→脚本框架 | **1** | ✅ |
| `storyboardGenerateV1` | WF02b 脚本确认→分镜图生成 | **1** | ✅ |
| `reviewSubmitVeoV2` | WF03 分镜审核→视频生成 | **1** | ✅ |
| `conceptSelectStoryboardV1` | 旧合并 WF02 | **0** | NULL ✅ |

旧合并 WF02 通过 bootstrap 显式 `active=0, activeVersionId=NULL` ✅  
`/api/env-status` 的 `workflows.ok=true` 确认 4 个核心 workflow 全部 active ✅  
bootstrap 每次启动时做 upsert（确保 activeVersionId 指向当前版本）✅

**证据路径**：DB 查询结果, `scripts/bootstrap-ai-video-workflows.mjs:225-232`, `版本测试/serve-review-assets.mjs:1944`  
**必须修复**：无  
**可延后**：UI 状态页展示每个 workflow 的 versionId（方便用户和客服核对版本）

---

### 模块 8：API Key / Credential 安全

**结论：✅ 通过**

**Bundle config seed**：所有 api_key 字段全部为空：
```
.kie.api_key: EMPTY
.gemini.api_key: EMPTY
.apis.creative_direction.api_key: EMPTY
.apis.script_framework.api_key: EMPTY
.apis.storyboard_image.api_key: EMPTY
.apis.image_to_video.api_key: EMPTY
.providers.kie.api_key: EMPTY
.providers.google.api_key: EMPTY
.tasks.image_to_video.api_key: EMPTY
```

**n8n credential 表**：空（无存储任何 credential）✅  
**UI 显示**：API Key masked 为 `0187****` ✅  
**diagnostics redact()**：覆盖 `api_key`, `Authorization`, `Bearer`, `AIzaSy*`, `sk-*`, `Kie[A-Za-z0-9_-]{10,}`, hex32 ✅  
**日志 key 泄露**：n8n.log 仅含 Python runner + image-edit-tools warning，无 API Key 明文 ✅  
**换用户**：App Support 独立，不同 Mac 账号数据完全隔离 ✅

**证据路径**：`版本测试/config/local-config.json`, `版本测试/serve-review-assets.mjs:6130-6145, 1811`  
**必须修复**：无  
**可延后**：无

---

### 模块 9：文件路径与权限

**结论：✅ 通过**

**/local-file 安全**（`serve-review-assets.mjs:6396-6412`）：
- URL 参数 `path` 经 `decodeURIComponent` 解析
- 扩展名白名单：`.mp4`, `.mov`, `.webm`, `.png`, `.jpg`, `.jpeg`
- `isAllowedLocalAssetPath()` 使用 `path.resolve()` + `path.sep` 前缀比较（防路径穿越）
- 白名单 roots：`ROOT`, `CACHE_ROOT/videos`, `CACHE_ROOT/final-video`, `CACHE_ROOT/分镜图裁剪`（P11 新增）

**中文路径处理**：
- URL 生成：`encodeURIComponent(panel.panel_preview_path)` ✅
- 文件读取：Node.js 原生支持 UTF-8 路径 ✅
- `分镜图裁剪` 路径已加入 allowedRoots ✅

**空格路径（`AI Video.app`）**：
- 所有路径操作通过 `path.join()` / `path.resolve()` 处理，非 shell 拼接 ✅
- 实际测试 `/local-file` 返回 HTTP 200（P12 验证）✅

**运行时 /Users/drew 路径**：仅出现在 validation guards 和 build metadata，不写入实际数据路径 ✅

**证据路径**：`serve-review-assets.mjs:834-842, 6396-6412, 831`  
**必须修复**：无  
**可延后**：无

---

### 模块 10：进程生命周期

**结论：✅ 通过**

| 机制 | 实现 | 状态 |
|------|------|------|
| 多开保护 | Electron `requestSingleInstanceLock()`；第二实例触发 `returnToWorkbench()` | ✅ |
| App 关闭 | `app.on('before-quit')` → `launcherProcess.kill('SIGTERM')` → launcher `shutdown(children)` SIGTERM+3s SIGKILL | ✅ |
| n8n watchdog | `setInterval(15s)` healthcheck → 失败自动重启 | ✅ |
| 自遗留进程识别 | `isPortOwnedByCurrentApp()` via `getProcessCommand()` 比较 PROJECT_ROOT / APP_SUPPORT_DIR | ✅ |
| 外部进程保护 | 外部占端口 → exit(1) + 中文提示，不 kill | ✅ |
| 僵尸进程防止 | SIGTERM→SIGKILL 双保险；`children` 数组跟踪 | ✅ |
| 启动失败提示 | n8n 45s 超时 → `dialog.showErrorBox` + 日志路径 | ✅ |
| 启动时序 | n8n→bootstrap→sync→n8n（stopChild 确保 DB 解锁）| ✅ |

macOS Dock 关闭行为：点 ✕ 隐藏窗口，不退出；通过 Dock 右键 Quit 才真正退出 + 杀子进程 ✅

**证据路径**：`desktop/main.cjs:15-332`, `client/launcher.mjs:272-335, 560-658`  
**必须修复**：无  
**可延后**：App 退出时提示"确认退出将停止本地服务"（防止用户误点 Quit）

---

### 模块 11：健康检查与日志

**结论：✅ 通过（有一个 gap）**

**可用端点**：
| 端点 | 内容 | 状态 |
|------|------|------|
| `/healthz` | `{"status":"ok"}` | ✅ |
| `/health/meta` | app_mode, ui_port, project_root, workflow_data_root, config_path, server_pid, started_at, kie_key_configured, license | ✅ |
| `/api/env-status` | ui/n8n/workflows(all 4 active)/apiKey/models/storage/activeProject | ✅ |
| `/config` 页面 | Kie Key masked, 模型状态, 端口 | ✅ |
| `export-diagnostics` | redact() 脱敏后导出 | ✅ |

**日志文件**：`~/Library/Application Support/AI Video/logs/launcher/`
- `n8n.log`：n8n 启动输出（含 Python/image-edit warning，非关键）
- `ui-18788.log`：UI 服务启动输出
- `prompt-migration.log`：prompt migration 记录（P12-FIX 新增）

**API Key 不泄露**：redact() 覆盖全部 key 格式 ✅

**Gap**：`/health/meta` 不含人类可读版本号（`package.json` 中 `version: "1.0.0"` 未暴露）。RC 名称（`0849`）仅从 `project_root` 字符串隐含可见，不适合客服/用户核对版本。

**证据路径**：`serve-review-assets.mjs:4977-4992, 5944-5963`, 运行态 curl 结果  
**必须修复**：无  
**可延后**：`/health/meta` 新增 `app_version` 字段（从 package.json 读取）或展示 RC 名称

---

### 模块 12：Reset / Reinitialize

**结论：✅ 通过（有 UX gap）**

| 入口 | 操作 | 范围 | 二次确认 |
|------|------|------|---------|
| 系统配置页 `清空项目缓存` | `clear-test-data` | 清空 context JSONs + 日志（保留 API Key、视频、n8n DB）| 无 |
| 系统配置页 `恢复出厂设置` | `factory-reset` | 清空 API Key + context JSONs + logs（保留视频文件）| **两次** confirm ✅ |
| Prompt 页 `恢复默认` | `resetPromptModule` | 单个 prompt 模块重置为 example | confirm ✅ |

**factory-reset 不清空**：`videos/`, `分镜图裁剪/`, `final-video/`（生成的媒体文件保留）— 合理 ✅  
**factory-reset 不重置 n8n DB**：executions / workflow 配置保留 — 可接受，业务数据不属于"出厂"范围  
**Prompt seed/migration**：删除 App Support prompt 后重启 → 从 bundle seed ✅；存在旧 prompt → migration 自动触发 ✅

**UX Gap（延后）**：无"彻底重置并重新初始化（含 n8n DB）"入口。若用户需要完全全新启动，需手动删除 `~/Library/Application Support/AI Video/`。App 无引导提示。

**证据路径**：`serve-review-assets.mjs:6013-6095`, `client/launcher.mjs:744-756`  
**必须修复**：无  
**可延后**：UI 提示"如需完全重置含 workflow 数据，请删除 App Support 目录"；bootstrap 失败后的 UI 层面重试按钮

---

## 新 Mac 用户测试 Checklist

适用于 2-3 台验证机，每台独立运行。不触发 Veo/Gemini/Kie 的验证项标注 `[无 API 费用]`。

### 测试前准备

| # | 项目 | 说明 |
|---|------|------|
| 1 | 机器要求 | macOS 12+ (Monterey 及以上)；无需安装 Node.js、n8n、npm |
| 2 | 账号要求 | 全新 macOS 用户账号（`~/Library/Application Support/AI Video/` 不存在）|
| 3 | 端口要求 | 5678 和 18788 未被占用 |
| 4 | 准备 Kie API Key | 用于 Step 3 配置；测试机上不预设 Key |
| 5 | 网络 | 需要访问 Kie API（国内需代理）|

### 安装与首次启动

| # | 步骤 | 预期结果 | 判定 |
|---|------|---------|------|
| 6 | 复制 `AI Video.app` 到 `/Applications/` | Finder 无报错 | `[无 API 费用]` |
| 7 | 双击打开 | macOS 弹出"未验证的开发者"对话框（ad-hoc sign 预期）；在系统设置-安全性允许打开 | `[无 API 费用]` |
| 8 | 等待约 30-45 秒 | 看到"AI Video 正在启动"加载页 → 自动跳转 `http://127.0.0.1:18788/` 工作台主页 | `[无 API 费用]` |
| 9 | 验证 App Support 已初始化 | `~/Library/Application Support/AI Video/` 存在；`config/`, `n8n-user/`, `workflow-data/`, `logs/`, `prompts/` 目录已创建 | `[无 API 费用]` |
| 10 | 健康检查 | `curl --noproxy '*' http://127.0.0.1:18788/healthz` 返回 `{"status":"ok"}`；`curl --noproxy '*' http://127.0.0.1:5678/healthz` 返回 `{"status":"ok"}` | `[无 API 费用]` |

### API Key 配置与初始状态验证

| # | 步骤 | 预期结果 | 判定 |
|---|------|---------|------|
| 11 | 访问 `/config`（系统配置页）| 看到 Kie API Key 输入框，初始为空；模型显示 gemini-3.1-pro / nano-banana-pro / veo3_lite | `[无 API 费用]` |
| 12 | 填写 Kie API Key，保存 | 保存成功；页面显示 Key masked；`/api/env-status` `apiKey.ok=true` | `[无 API 费用]` |
| 13 | 验证 prompt 为 P11 新版本 | 访问 `/prompt-center`；确认 director 部分不含"6 到 9 个镜头"；script 部分含"TikTok 短平快约束"和"口播者一致性约束" | `[无 API 费用]` |
| 14 | 验证工作流 active | `/api/env-status` → `workflows.ok=true`, WF01/WF02a/WF02b/WF03 全部 active | `[无 API 费用]` |

### WF01 表单提交（需 Kie API，授权后执行）

| # | 步骤 | 预期结果 | 判定 |
|---|------|---------|------|
| 15 | 访问主页，填写表单（产品名、市场、语言、创作类型）| 提交后跳转 `/submitted` | 消耗 Gemini |
| 16 | 等待 WF01 完成（约 60-90s）| 跳转创意方向选择页；显示 3 个方向 | 消耗 Gemini |
| 17 | 选择创意方向 | 跳转脚本确认页 | 消耗 Gemini |
| 18 | 确认脚本 | 跳转分镜图生成页 | 消耗 Nano Banana |
| 19 | 等待分镜图生成（约 90s）| 显示 6 个分镜图缩略图（非"无图"占位）| 消耗 Nano Banana |
| 20 | **验证分镜图可见**（P11 Fix 验证）| 6 个缩略图均有实际图片，不显示"暂无预览图" | 消耗 Nano Banana |
| 21 | 审核分镜图，确认提交 → 开始生成视频 | 跳转 WF03 进度页 | 消耗 Kie/Veo |
| 22 | 等待视频生成完成（约 15-30min）| final-video 页 7 个 badge-done（6 shot + 1 合成）| 消耗 Kie/Veo |

### 端口冲突与退出重启验证

| # | 步骤 | 预期结果 | 判定 |
|---|------|---------|------|
| 23 | 退出 App（Cmd+Q 或 Dock 右键 Quit）| App 窗口关闭；端口 5678/18788 释放（可用 `lsof -i:5678` 确认）| `[无 API 费用]` |
| 24 | 重新启动 App | 正常启动；数据（API Key、项目历史）保留 | `[无 API 费用]` |
| 25 | 端口冲突模拟（可选）| 手动占用 5678；启动 App → 看到中文错误弹框说明端口被占；退出后释放 5678 → 正常启动 | `[无 API 费用]` |

### 删除 App Support 后重新初始化

| # | 步骤 | 预期结果 | 判定 |
|---|------|---------|------|
| 26 | 退出 App | ✅ |
| 27 | 删除 `~/Library/Application Support/AI Video/` | 文件夹删除 | `[无 API 费用]` |
| 28 | 重新启动 App | 重新初始化：新建 DB、bootstrap、sync；App Support 目录重建；API Key 需重新配置 | `[无 API 费用]` |
| 29 | 确认工作流 active | `/api/env-status` `workflows.ok=true` | `[无 API 费用]` |

### 日志导出与错误提示

| # | 步骤 | 预期结果 | 判定 |
|---|------|---------|------|
| 30 | 访问 `/config` → 导出诊断包 | 生成诊断 JSON；不含 API Key 明文（redact）| `[无 API 费用]` |
| 31 | 在日志文件中搜索 Key | `grep -r "0187" ~/Library/Application Support/AI Video/logs/` → 无明文 Key | `[无 API 费用]` |

### 通过/失败标准

**通过标准**：
- Step 8（主页加载）✅
- Step 12（API Key 配置）✅
- Step 14（所有 workflow active）✅
- Step 19（分镜图有实际图片）✅（P11 Fix 核心验证项）
- Step 22（final-video 7 badge-done）✅
- Step 24（退出重启保留数据）✅
- Step 28（删除 App Support 后重新初始化）✅

**失败标准**：
- Step 8 无法打开或卡在加载页超过 90s
- Step 14 任一 workflow active=0
- Step 19 6 个分镜图均显示"暂无预览图"（P11 Fix 未生效）
- Step 22 final-video badge-failed 或 badge-loading 不归零
- 任意步骤出现 API Key 明文泄露

---

## 必须修复项（影响新用户交付的硬问题）

**无硬阻塞项。**

当前候选包可发第一批内测。

---

## 可延后项（不影响第一批内测的优化项）

| # | 模块 | 描述 | 优先级 |
|---|------|------|--------|
| D1 | 模块 3 | n8n 日志 Python runner / image-edit-tools warning 噪声（42+ 次）| P2 |
| D2 | 模块 5 | 端口冲突时无动态 fallback，只报错不自动重试 | P2 |
| D3 | 模块 11 | `/health/meta` 不含人类可读版本号/RC 标识 | P2 |
| D4 | 模块 12 | 无"完全重置含 n8n DB"的 UI 引导 | P3 |
| D5 | 模块 10 | App 退出时无"将停止本地服务"提示 | P3 |
| D6 | 模块 1 | node_modules build metadata 48 个文件含 /Users/drew（干净 rebuild 消除）| P3 |
| D7 | 模块 7 | UI 状态页不展示 workflow versionId | P3 |

---

## 最小修复方案

**当前轮次无需修复。**

如进行下一轮修复，建议优先级：

1. **D3（模块 11）**：在 `/health/meta` 响应中增加 `app_version` 字段（读取 package.json version），3 行代码。
2. **D1（模块 3）**：在 `n8n-task-runners.json` 中移除 `image-edit-tools` allowlist，或在 UI 配置页显示"Python/image-edit 功能未安装（当前版本不需要）"说明。
3. **D2（模块 5）**：端口冲突时引导用户查看具体占用程序，或提供"一键尝试备用端口"选项。

以上均不涉及 workflow JSON、节点连接、schema、Code 节点、Prompt 结构。

---

## 判断：是否建议进入 2-3 台 Mac 新用户测试

**✅ 建议进入。**

0849 RC 当前状态：
- 运行态 prompt 已刷新为 P11 新版本（P12-FIX migration 已验证）
- 分镜图预览 /local-file 修复已验证（P11 Fix）
- recommended_grid 固定 6_grid（P11 Fix）
- TikTok 短平快 + 口播者一致性约束已生效
- API Key bundle 清空，数据隔离，进程生命周期完整
- 12 个模块无硬阻塞项

进入新用户测试前，测试机务必确认：无 AI Video App Support 数据、端口空闲、有 Kie API Key。

---

## 关键文件索引

| 文件 | 用途 |
|------|------|
| `docs/P13-new-user-delivery-audit-20260528.md` | 本文件 |
| `docs/P12-FIX-prompt-migration-20260528.md` | P12-FIX prompt migration 记录（第 4 stale 条件见本文件补记）|
| `release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app` | 当前审计候选包 |
| `client/launcher.mjs` | 启动器（端口管理、workflow bootstrap、进程生命周期）|
| `desktop/main.cjs` | Electron 主进程（单例锁、Node 路径、UI 窗口）|
| `scripts/bootstrap-ai-video-workflows.mjs` | workflow 初始化脚本 |
| `sync_iteration_v1_workflows_to_db.mjs` | workflow 版本同步脚本 |
| `版本测试/serve-review-assets.mjs` | UI 服务（路由、健康检查、reset、local-file、prompt migration）|
| `~/Library/Application Support/AI Video/` | 运行时全部用户数据 |
