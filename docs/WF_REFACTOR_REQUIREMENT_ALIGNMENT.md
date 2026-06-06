# WF_REFACTOR_REQUIREMENT_ALIGNMENT

工程审计时间：2026-05-09  
审计范围：只读检查，不修改任何 workflow JSON、源码、缓存或视频文件。  
唯一写入：本报告。  
执行者：Claude Code（n8n 工程执行者）  
本阶段完成后停止，等待人工与 Codex 确认。

---

## 1. 当前项目现状

### 1.1 整体结构

| 层级 | 说明 |
|------|------|
| n8n 工作流 | 三个独立 workflow（WF01/02/03），均已 Active |
| UI 工作台 | `serve-review-assets.mjs` 提供本地 HTTP 服务，端口 8787 |
| 上下文存储 | 本地 JSON 文件（`.n8n-local-cache/` 目录） |
| 输出目录 | `/Users/drew/Downloads/n8n视频/`（视频）、`/Users/drew/Downloads/n8n分镜图裁剪/`（分镜图） |
| 提示词管理 | 嵌入在 `Prompt Library` Code 节点 + `tiktok-workflow-prompts.json` 文件 |
| API 配置 | 混合：环境变量 `$env.GEMINI_API_KEY`、写死 Key、文件读取（`/Users/drew/.n8n/modelhub-api-key`） |
| 部署形态 | 本地单用户，macOS，n8n + Node.js |

### 1.2 可运行状态（截至审计日）

- WF01 / WF02 / WF03 均 Active
- 8787 工作台正常
- ModelHub API Key 已写入文件（key 未写入本报告）
- 已通过 `stability_check.mjs` 验证
- 当前生产版本 WF03 为 `simplified-v1`：不含 TTS / 音频合成 / scene-audio 逻辑

---

## 2. 三个 Workflow 的实际结构

### WF01：主流程 — 表单到创意方向

- **文件**：`正式导入文件/01-主流程-表单到创意方向.json`
- **Workflow ID**：`rKHHjD2QBlL6EhaM`
- **触发器**：n8n Form Trigger（`/form/...`）
- **入口**：用户填写 n8n 表单并提交
- **输出**：
  - 调用 Gemini 生成创意方向（director layer）
  - 生成 6 镜头脚本框架（script layer）
  - 调用 NanoBanana 生成分镜宫格图（storyboard image）
  - 裁切分镜图为 6 个 9:16 子图（sharp 裁切）
  - 打包分镜审核数据（review_context）
  - 将 concept_context 写入 `.n8n-local-cache/concept-context/concept_context_{project_id}.json`
  - 将 project_state 写入 `.n8n-local-cache/project-state/project_{project_id}.json`
  - 将 review_context（含分镜打包）写入 `.n8n-local-cache/review-context/`
  - 跳转工作台 `http://127.0.0.1:8787/submitted?context=...`
- **重要**：WF01 当前同时执行了 WF02 的逻辑（脚本 + 分镜图生成），实际上是一个大流程，不是"只到创意方向"

### WF02：续跑 — 创意方向选择到分镜

- **文件**：`正式导入文件/02-续跑-创意方向到分镜.fixed-context.json`（推荐版本）
- **Workflow ID**：`conceptSelectStoryboardV1`
- **触发器**：Webhook（`/webhook/concept_select_resume`）
- **入口**：用户在工作台 `/submitted` 页面点击"选择创意方向"，UI 调用 POST `/concept-select`，`serve-review-assets.mjs` 触发此 webhook
- **输出**：
  - 从 concept_context JSON 文件恢复上下文
  - 重跑脚本 + 分镜图生成 + 裁切 + 打包
  - 生成新的 review_context 并跳转审核列表
- **用途**：用户未满意创意方向，选择另一个方向后重跑分镜（局部重跑）

### WF03：续跑 — 分镜审核到视频生成

- **文件**：`正式导入文件/03-续跑-分镜审核到视频.simplified-v1.json`（当前生产版本）
- **Workflow ID**：`reviewSubmitVeoV2`
- **触发器**：Webhook（`/webhook/review_submit_resume`）
- **入口**：用户在工作台 `/reviews/item` 页面提交审核，UI 调用 POST `/review-submit`，触发此 webhook
- **输出**：
  - 解析用户确认（通过/重做）
  - 从 review_context 恢复分镜数据
  - 逐镜串行提交 ModelHub（`veo3.1-fast`）图生视频
  - 轮询视频生成状态
  - 下载视频到 `/Users/drew/Downloads/n8n视频/`
  - 更新 review_progress JSON
  - 支持：失败重跑（重写 Veo prompt）、暂停、继续生成剩余镜头

### 三个 Workflow 的串联方式

```
WF01 → 写 concept_context JSON → UI(8787) 展示
用户选择创意方向 → UI POST /concept-select → 触发 WF02 webhook
WF02 → 写 review_context JSON → UI(8787) 展示
用户确认分镜 → UI POST /review-submit → 触发 WF03 webhook
WF03 → 生成视频 → 写 review_progress JSON → UI(8787) 展示
```

**串联机制**：本地 JSON 文件路径（context_path）通过 webhook payload 传递。`project_id` 贯穿所有文件名，但没有显式的数据库外键约束。三个 workflow 之间靠"文件路径引用"而非共享数据库串联。

---

## 3. Code 节点审计表

### WF01 Code 节点（共 14 个）

| 节点名称 | 功能 | 建议 |
|----------|------|------|
| `Prompt Library` | 嵌入全部 Prompt，输出供下游使用 | **保留**，但建议抽离为外部文件读取 |
| `加载默认测试图片` | 写死默认测试图路径，处理上传图片 | **替换**：Set 节点 + 配置变量；图片路径不应写死 |
| `导演请求体组装` | 组装 Gemini 导演请求体（含 prompt 模板渲染） | **保留**：模板渲染逻辑较复杂 |
| `创意方向提取` | 从 Gemini 返回中提取 JSON（含 markdown fence 清洗） | **保留**：LLM 返回清洗必须用 Code |
| `Code in JavaScript`（概念选择） | 解析 creative_concepts_json，选第 0 个方向 | **可简化**：可改为 Set/IF 节点 |
| `脚本请求体组装` | 组装 Gemini 脚本请求体，含图片读取 | **保留**：包含 fs.readFile + base64 转换 |
| `提取脚本框架JSON` | 从 Gemini 返回中提取 JSON | **保留**：LLM 返回清洗 |
| `拆分shots数组` | shots 数组 map，字段整理 | **可改**：部分可用 Split In Batches + Set 替代；但字段整理混入，建议拆开 |
| `Code in JavaScript1`（图片读取） | 从路径读取图片转 base64 | **保留**：文件 I/O |
| `Code in JavaScript2`（分镜提示词提取） | 从 Gemini 返回中提取 JSON | **保留**：LLM 返回清洗 |
| `组装NanoBanana执行字段` | 组装 NanoBanana 请求体 + 模板渲染 | **保留**：复杂组装逻辑 |
| `提取NanoBanana返回图片` | 深度递归解析 NanoBanana 返回图片 | **保留**：复杂解析 |
| `nano banana` | 调用 gemini-generate.mjs 子进程执行 NanoBanana | **保留**：子进程执行，无原生替代 |
| `本地图片转Gemini输入` | 读取本地图片转 inlineData | **保留**：文件 I/O |
| `Nano前_轻量上下文` | 从上下文中 pick 图片路径 | **可简化**：部分逻辑可用 Set 节点 |
| `六宫格裁切_9x16` | 使用 sharp 裁切 NanoBanana 宫格图 | **保留**：图像处理，无原生替代 |
| `NanoBanana结果落盘` | 将裁切图片写入本地文件 | **保留**：文件 I/O |
| `分镜确认打包` | 整理 panels 数组并写入 review_context | **部分替换**：写文件部分保留，字段整理可 Set |
| `保存创意方向上下文` | 写 concept_context + project_state JSON | **保留**：文件 I/O + 多文件写入 |

### WF02 Code 节点（WF01 下游相同节点共享，新增 3 个）

| 节点名称 | 功能 | 建议 |
|----------|------|------|
| `concept_select_normalize` | 规范化 webhook 输入 | **可替换**：Set 节点 |
| `concept_select_restore` | 从 concept_context JSON 文件恢复上下文 | **保留**：文件 I/O |
| `Code in JavaScript`（WF02 入口） | 解析 concept_context，提取已选方向 | **保留**：文件读取 + JSON 解析 |
| 其余节点 | 与 WF01 共享相同节点结构 | 同 WF01 |

### WF03 Code 节点（共 19 个）

| 节点名称 | 功能 | 建议 |
|----------|------|------|
| `review_submit_normalize` | 规范化 webhook 输入，标准化 shot_token | **可替换**：Set 节点 |
| `解析用户确认` | 解析 decision（通过/重做），读取 review_context JSON | **保留**：文件 I/O + 解析 |
| `恢复已确认分镜` | 从 review_context 恢复 panels 数组 | **保留**：文件 I/O |
| `准备重生成反馈` | 整理重做参数 | **可替换**：Set 节点 |
| `Veo图片上传元数据` | 提取 binary panel_9x16 元数据 | **保留**：binary 处理 |
| `Veo请求体组装` | 组装 ModelHub 请求体，含 base64 图片 | **保留**：复杂组装 + 文件读取 |
| `逐镜视频_API_占位` | curl 调用 ModelHub API 提交视频任务 | **保留**：curl 子进程执行 |
| `Veo提取任务ID` | 解析 ModelHub submit 返回，提取 request_id | **保留**：复杂解析 + URL 查找 |
| `Veo查询任务状态` | curl 调用 ModelHub 查询任务状态 | **保留**：curl 子进程执行 |
| `Veo解析任务状态` | 解析状态返回，提取视频 URL | **保留**：复杂解析 |
| `Veo下载视频` | curl 下载视频，写 progress JSON | **保留**：文件 I/O + curl |
| `审核进度初始化` | 初始化 review_progress JSON | **保留**：文件 I/O |
| `Veo进度_开始分镜` | 更新 progress → running | **保留**：文件 I/O（原子写） |
| `Veo进度_已提交任务` | 更新 progress → submitted | **保留**：文件 I/O |
| `Veo进度_完成分镜` | 更新 progress → completed/failed | **保留**：文件 I/O |
| `Veo结果汇总` | 汇总所有 shot 结果，更新 progress | **保留**：复杂逻辑 + 文件 I/O |
| `Veo失败恢复策略` | 判断失败策略（跳过/重写 prompt） | **部分可 IF**：但条件逻辑复杂，建议保留 |
| `Veo失败提示词请求体` | 从文件读取 veo_repair prompt，组装请求 | **保留**：文件 I/O + 模板渲染 |
| `Veo失败提示词解析` | 解析 Gemini 返回的修复 prompt | **保留**：LLM 返回清洗 |

### Code 节点总结

- 总计：WF01（19 个）+ WF02（3 个新增 + 共享）+ WF03（19 个） ≈ 约 41 个独立 Code 节点
- **建议替换成原生节点**：约 7-8 个（`review_submit_normalize`、`准备重生成反馈`、`加载默认测试图片`、`concept_select_normalize`、部分字段整理节点）
- **必须保留 Code 节点**：约 33 个（LLM 返回清洗、文件 I/O、子进程执行、binary 处理）
- **核心问题**：多个 Code 节点身兼多职（组装+清洗+写文件），建议每个 Code 节点只做一件事并加注释

---

## 4. Prompt 写死位置清单

### 4.1 嵌入在 `Prompt Library` Code 节点中（WF01 / WF02 共用）

该节点把全部 prompt 以 JSON 字符串硬编码在 JavaScript 代码中，通过 `const PROMPTS = {...}` 直接定义。修改 prompt 必须进 n8n 画布编辑 Code 节点。

| Prompt 名称 | 字段 | 当前位置 |
|-------------|------|---------|
| director.system_instruction | 导演系统 prompt | Prompt Library Code 节点 |
| director.user_template | 导演用户 prompt（含模板变量） | Prompt Library Code 节点 |
| director.generation_config | Gemini 模型参数（temperature、maxTokens 等） | Prompt Library Code 节点 |
| script.system_instruction | 脚本系统 prompt | Prompt Library Code 节点 |
| script.user_template | 脚本用户 prompt | Prompt Library Code 节点 |
| script.generation_config | Gemini 模型参数 | Prompt Library Code 节点 |
| storyboard（分镜图提示词生成）| NanoBanana 前置分镜提示词生成 prompt | Prompt Library Code 节点 |
| nanobanana_image | NanoBanana 图生图 system/user prompt | Prompt Library Code 节点 |
| storyboard_grid 配置 | 宫格尺寸、裁切参数 | Prompt Library Code 节点 |
| creative_task_type_mapping | 任务类型映射规则 | Prompt Library Code 节点（部分）+ `config/creative_task_type_mapping.json` |

### 4.2 写在 `tiktok-workflow-prompts.json` 文件中

| Prompt 名称 | 字段 | 当前位置 |
|-------------|------|---------|
| veo_repair.system_instruction | Veo 失败修复系统 prompt | `tiktok-workflow-prompts.json` |
| veo_repair.user_template | Veo 失败修复用户 prompt | `tiktok-workflow-prompts.json` |

该文件由 WF03 `Veo失败提示词请求体` 节点用 `fs.readFileSync` 读取（路径写死在代码中）。

### 4.3 目前未被 workflow 直接加载的文件

`prompts/` 目录下的 `.txt` 文件（`00_director_system_prompt.txt` 等）是**参考备份**，workflow 不直接读取这些文件。

### 4.4 可给用户修改的 Prompt

- director prompt（方向性，Hook 风格）
- script prompt（镜头节奏、CTA 强度）
- nanobanana storyboard prompt（画面风格）
- veo_repair prompt（失败修复策略）

### 4.5 不建议给普通用户修改的部分

- JSON 字段名（如 `shot_id`、`shot_order`、`stage` 等）—— 改变会导致下游节点静默失败
- `generation_config`（temperature、maxOutputTokens）—— 改错可能导致输出截断或格式异常
- storyboard_grid 裁切参数（宽高比、裁切 inset）—— 改变会导致裁切错位

---

## 5. API 配置写死位置清单

### 5.1 Gemini 文本模型（WF01 / WF02）

| 位置 | 现状 |
|------|------|
| HTTP Request 节点 URL | `{{ $env.GEMINI_TEXT_MODEL_URL \|\| 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=' + $env.GEMINI_API_KEY }}` |
| 读取方式 | 优先读取 `$env.GEMINI_TEXT_MODEL_URL`（完整 URL），否则拼接 Key；Key 来自 `$env.GEMINI_API_KEY` |
| 模型名称 | `gemini-3-flash-preview` 写死在 fallback URL 中 |
| n8n Credential | **未使用**，不依赖 n8n Credential |

### 5.2 Gemini 图像模型（NanoBanana）—— 关键问题

| 位置 | 现状 |
|------|------|
| `nano banana` Code 节点 | API Key `AIzaSy...REDACTED` **写死**在 Code 节点中 |
| 调用方式 | 通过 `gemini-generate.mjs` 子进程执行，URL + Key 作为命令行参数 |
| 模型名称 | `gemini-3.1-flash-image-preview` 写死在 Code 节点中 |

**⚠️ 严重**：此 Key 为开发者私钥，写死在 workflow JSON 中，分发给用户后会暴露。

### 5.3 Gemini 文本模型（WF03 失败修复）—— 关键问题

| 位置 | 现状 |
|------|------|
| `Veo失败提示词生成` HTTP Request 节点 | URL `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=AIzaSy...REDACTED` **完全写死** |
| n8n Credential | **未使用** |

**⚠️ 严重**：此处 Key 同样写死。

### 5.4 ModelHub 视频模型（WF03）

| 位置 | 现状 |
|------|------|
| API Key | 从 `/Users/drew/.n8n/modelhub-api-key` 文件读取，或 `MODELHUB_API_KEY` 环境变量 |
| 提交 URL | `https://api.modelhub.me/v1/videos`（写死在 Code 节点，但可通过 `json.modelhub_submit_url` 覆盖） |
| 模型名称 | `veo3.1-fast`（Code 节点默认值，可通过 `json.video_model` 覆盖） |

**相对安全**：Key 不写入 workflow JSON，但路径 `/Users/drew/.n8n/modelhub-api-key` 写死，换用户目录必须改。

### 5.5 n8n Credential 使用情况

- **三个 workflow 均未使用 n8n Credential**
- 所有 API 调用均通过：环境变量、Code 节点写死、或本地文件读取
- 优点：不需要用户在 n8n UI 里手动创建 Credential
- 缺点：API Key 管理分散，部分写死在 JSON 中，不安全

---

## 6. 上下文存储现状

### 6.1 存储方式

**当前唯一存储方式：本地 JSON 文件**，存储在 `.n8n-local-cache/` 下各子目录：

| 目录 | 内容 | 写入者 | 读取者 |
|------|------|--------|--------|
| `concept-context/` | 创意方向 + 产品信息 + 图片路径 | WF01 `保存创意方向上下文` | WF02 `concept_select_restore`、UI |
| `project-state/` | 项目高层状态（project_id, status） | WF01 `保存创意方向上下文` | UI(`serve-review-assets.mjs`) |
| `review-context/` | 分镜审核包（panel_review_pack） | WF01/WF02 `分镜确认打包` | WF03 `解析用户确认`、UI |
| `review-progress/` | 逐镜视频生成进度 | WF03 各进度节点 | WF03（重跑判断）、UI |
| `uploaded-product-images/` | 上传的产品图 | WF01 `加载默认测试图片`（暂命名） | WF01/WF02 各图片读取节点 |
| `nanobanana/` | NanoBanana 生成的宫格图 | WF01/WF02 `NanoBanana结果落盘` | WF01/WF02 裁切节点 |
| `gemini-requests/` | Gemini API 请求体（debug 日志） | `nano banana` Code 节点 | 仅供排查，不被 workflow 读取 |
| `selected-concepts/` | 用户选择的创意方向（UI 侧记录） | UI `serve-review-assets.mjs` | UI |

### 6.2 当前没有的存储机制

- **无 SQLite 表**（n8n 自带的 `database.sqlite` 存 workflow/执行历史，但 workflow 本身未建业务表）
- **无 n8n DataTable 节点**
- **无 Notion/Airtable 等外部存储**
- **无 memory 节点**
- **无 ai_runs / revisions 记录**（每次调用不落盘，历史 Gemini 请求体只在 `gemini-requests/` 存 debug 副本）

### 6.3 当前 project_id 串联机制

- project_id 由 WF01 生成：`'proj_' + Date.now()`（Unix 毫秒时间戳）
- project_id 写入所有 JSON 文件名和文件内容
- WF02 / WF03 通过 webhook payload 接收 `review_context_path`，从中隐式获得 project_id
- **三个 workflow 之间没有显式的 project_id 外键数据库约束**，纯靠文件路径引用

---

## 7. UI 现状

### 7.1 UI 入口与页面

`serve-review-assets.mjs` 是一个 Node.js HTTP 服务器，监听 `127.0.0.1:8787`，提供以下路由：

| 路由 | 方法 | 功能 |
|------|------|------|
| `/` | GET | 工作台首页（重定向到最新项目或概念列表） |
| `/healthz` | GET | 健康检查 |
| `/submitted` | GET | 表单提交后创意方向展示页 |
| `/active` | GET | 跳转到最新活跃项目 |
| `/concepts` | GET | 创意方向列表 |
| `/concepts/item` | GET | 单个创意方向详情 |
| `/concept-status` | GET | 创意方向生成状态 |
| `/concept-select` | POST | 用户选择创意方向（触发 WF02 webhook） |
| `/reviews` | GET | 分镜审核列表 |
| `/reviews.json` | GET | 审核列表 JSON API |
| `/reviews/context` | GET | 原始分镜 context JSON |
| `/reviews/item` | GET | 分镜审核详情页（含提交表单） |
| `/review-status` | GET | 视频生成进度状态页 |
| `/review-submit` | POST | 提交审核结果（触发 WF03 webhook） |
| `/review-rerun-failed` | POST | 只重跑失败镜头 |
| `/review-rerun-pending` | POST | 继续生成剩余镜头 |
| `/review-pause-project` | POST | 暂停项目 |
| `/images/...`、`/videos/...` 等 | GET | 静态文件服务 |

### 7.2 当前 UI 没有的页面

- **API 配置页**（用户无法通过 UI 修改 Gemini Key、ModelHub Key）
- **Prompt 编辑页**（用户无法通过 UI 修改 prompt）
- **错误日志导出页**
- **问题反馈包导出**
- **项目历史列表**（只显示最近 6 个项目）
- **产品图管理页**（上传 0-5 张图片）

---

## 8. 视频生成 UI 控制现状

### 8.1 已有的按钮/功能

在 `/review-status` 页面（审核续跑状态页）：

| 功能 | 状态 |
|------|------|
| 返回审核列表 | ✅ 有 |
| 继续生成剩余镜头 | ✅ 有（`POST /review-rerun-pending`） |
| 暂停项目 | ✅ 有（`POST /review-pause-project`） |
| 只重跑失败镜头 | ✅ 有（`POST /review-rerun-failed`） |
| 查看脚本与提示词 JSON | ✅ 有（链接到 `/reviews/context`） |

### 8.2 缺失的按钮/功能

| 缺失功能 | 说明 |
|----------|------|
| 返回工作台 | ❌ 无（需要加首页链接） |
| 重新生成当前镜头（指定单个 shot） | ❌ 无（当前只能重跑"全部失败"或"全部剩余"） |
| 用户对单个镜头输入反馈后重做 | ❌ 无 |
| 重新合成最终视频 | ❌ 无（当前视频是分镜头文件，无合成逻辑） |
| 查看错误日志（结构化） | ❌ 无（当前只有执行状态摘要） |
| 分镜图用户反馈并重做（B 模式：Gemini 重写 storyboard prompt） | ❌ 无 |
| 创意方向用户反馈并重跑 | ❌ 无（当前只能选另一个方向，不能反馈后重跑） |
| 分镜脚本用户反馈并重跑 | ❌ 无 |

### 8.3 project_status / scene_status 现状

当前 `project_state.json` 中的 `status` 字段仅有：

- `waiting_for_concept_selection`
- （WF02/03 写入的更新状态未统一）

`review_progress.json` 中的 shot 状态字段（`status` per shot）：

- `pending`
- `running`
- `completed`
- `failed`
- `paused`

**缺失**：`creative_generated`、`script_generated`、`storyboard_image_generated`、`scenes_cropped`、`veo_prompts_generated`、`scene_videos_paused`、`final_video_generated` 等状态枚举未定义。

---

## 9. 可实现需求清单

以下需求评估为技术上可实现，风险较低：

| 需求 | 实现路径 | 难度 |
|------|----------|------|
| 清除 nano banana / WF03 中写死的 API Key | 替换为读取本地文件或环境变量（参考 ModelHub 做法） | 低 |
| 统一 API Key 读取机制（所有 Key 走文件或 env） | 修改 nano banana Code 节点 + WF03 HTTP Request 节点 | 低 |
| 将 prompts 从 Prompt Library 节点抽离到 JSON 文件 | 类似 `tiktok-workflow-prompts.json` 的做法，用 `fs.readFileSync` 读取 | 中 |
| 在 UI 增加"返回工作台"按钮 | `serve-review-assets.mjs` 添加链接 | 低 |
| 在 UI 增加"单个 shot 重做 + 反馈"功能 | 新增 POST 路由 + WF03 支持接受 bad_shot_ids 参数 | 中 |
| 扩展 product_images 支持 0-5 张 | 修改 Form 字段 + 加载默认测试图片节点 + 请求体组装节点 | 中 |
| 统一 project_status 状态枚举（落盘到 project_state.json） | 修改各 workflow 写 project_state 的节点 | 中 |
| 建立 ai_runs 结构（落盘每次 AI 调用） | 在 WF01/02/03 各 LLM 调用节点后增加写盘节点 | 中 |
| 创意方向反馈重跑（Prompt + feedback 重新调用 Gemini） | WF01 或新建 WF01b 续跑 webhook + UI 表单 | 中 |
| 分镜脚本反馈重跑 | 类似 WF02 续跑机制，增加反馈字段传入 | 中 |
| 分镜图 B 模式重做（Gemini 重写 storyboard prompt 后再调 NanoBanana） | WF02 中增加反馈重写路径 | 中 |
| UI 配置页写入 config.json（API Key + STORAGE_PATH） | Node.js 路由 + 前端表单 | 中 |
| 单个 shot 反馈后重做 Veo prompt + 重跑 Veo | WF03 已有 `Veo失败恢复策略` + `Veo失败提示词生成` 路径，扩展即可 | 中 |
| 硬编码路径统一替换为相对路径或 config 变量 | 需要替换所有 `/Users/drew/...` 写死路径 | 中 |
| 错误日志结构化（project_id + node + message + 时间） | 在 WF03 失败节点后写 error_log JSON | 中 |

---

## 10. 有风险的需求清单

| 需求 | 风险 | 说明 |
|------|------|------|
| 将 Prompt Library 从 Code 节点改为外部文件读取 | 中风险 | 每次 workflow 执行需要从磁盘读文件，路径硬编码需同步修改 |
| 动态 0-5 张图片支持 | 中风险 | 当前 `本地图片转Gemini输入` 节点写死 image_1_path / image_2_path；NanoBanana 请求体构建也依赖固定图片数量；需要全链路改 |
| 动态 6-9 镜头支持 | 高风险 | 当前 prompt、裁切节点、NanoBanana 布局全部写死 6 宫格，改动影响整条链路 |
| UI 配置页修改 API Key 后实时生效到 workflow | 中风险 | n8n workflow 执行时从文件读 Key，需确保写文件和读文件时序正确 |
| 将上下文存储从 JSON 文件迁移到 SQLite | 中风险 | 三个 workflow 都有文件读写节点，迁移需同时改所有节点；且 n8n Code 节点写 SQLite 需要 `better-sqlite3` 依赖 |
| 视频合成（ffmpeg 多镜头合成最终视频） | 中风险 | 当前 `Veo结果汇总` 只汇总单镜头文件，无合成逻辑；需要新增 ffmpeg 调用节点 |
| WF00_Master_Orchestrator | 低-中风险 | 可以实现，但需要确保不影响现有三个 workflow 的独立运行 |

---

## 11. 第一阶段建议做什么

**目标：安全清除硬编码、建立稳定的配置读取机制，不破坏现有可运行版本。**

### P0.1 必须做：清除写死的 API Key

- `nano banana` Code 节点（WF01/WF02）：将写死的 Gemini API Key 替换为从 `/Users/drew/.n8n/gemini-api-key` 或 `$env.GEMINI_API_KEY` 读取
- WF03 `Veo失败提示词生成` HTTP Request 节点：URL 中写死的 Key 替换为 `$env.GEMINI_API_KEY`

### P0.2 必须做：统一 API Key 读取机制

所有 API Key 统一走以下优先级：
1. 本地文件（`~/.n8n/{provider}-api-key`），参考 ModelHub 现有做法
2. 环境变量（`$env.GEMINI_API_KEY`、`$env.MODELHUB_API_KEY`）
3. 报错提示用户填写，不写默认值

### P0.3 必须做：移除硬编码的开发者路径

将 `/Users/drew/...` 路径改为：
- 基于 `__dirname` 或相对路径
- 或读取 `config.json`（`STORAGE_PATH`、`PROJECT_ROOT`）

### P1 建议做：将 Prompt 从 Code 节点抽到外部文件

- 参考 `tiktok-workflow-prompts.json` 的结构，将 Prompt Library 内容迁出
- workflow 启动时读取文件，用户可以直接编辑文件修改 prompt
- 第一版不需要 UI 修改 prompt，文件编辑即可

### P1 建议做：扩展 product_images 到 0-5 张

- 表单改为支持 0-5 张上传
- `加载默认测试图片` 节点逻辑改为处理 product_images 数组
- 下游请求体组装节点改为遍历 product_images 数组

### P1 建议做：建立 project_status 状态枚举

- 在 `project_state.json` 中写入完整状态字段
- WF01/02/03 各关键节点后写入对应状态

---

## 12. 第二阶段建议做什么

**目标：建立可审查、可局部重跑、可交付的用户操作体验。**

### P2.1 建立 ai_runs 落盘结构

- 每次 Gemini/ModelHub 调用前后各写一条 `ai_run` JSON 记录
- 包含：run_id、project_id、stage、prompt_id、input_snapshot、model_response、status、created_at
- 存储位置：`.n8n-local-cache/ai-runs/` 目录

### P2.2 建立创意方向反馈重跑路径

- UI 在创意方向展示页增加"反馈并重新生成"按钮
- POST 新路由 → 触发新 Webhook → WF01 续跑变体（传入 previous_concepts + user_feedback）

### P2.3 建立分镜脚本反馈重跑路径

- UI 在分镜审核前增加脚本审查步骤
- 支持用户填写脚本反馈，局部重跑脚本（不重跑 NanoBanana）

### P2.4 建立分镜图 B 模式重做路径

- UI 在 review 页增加"反馈并重做分镜图"入口
- WF02 续跑变体：Gemini 重写 storyboard prompt → 再调 NanoBanana

### P2.5 建立单个 shot 反馈重做路径

- UI 在 review-status 页增加 per-shot 反馈表单
- POST 路由 → 触发 WF03 续跑：只重做指定 shot，携带用户反馈

### P2.6 UI 增加 API 配置页

- 用户在 UI 填写 API Key、Base URL、Model 名称
- 保存到 `config.json`
- 各 workflow 启动时读取 `config.json`

### P2.7 建立错误日志结构化和导出

- 写入 `error_log_{project_id}.json`
- UI 增加"导出问题反馈包"功能

---

## 13. 不建议现在做什么

| 不建议做的事 | 理由 |
|-------------|------|
| 动态 6-9 镜头支持 | 影响 prompt、NanoBanana 布局、裁切、WF02 全链路；P0 稳定性优先 |
| 将上下文迁移到 SQLite（业务表） | 改动面极大；JSON 文件方案已够用，且可人工检查；迁移后 debug 难度更高 |
| 将三个 workflow 合并 | 违背已有设计原则；单一大 workflow 会导致表单卡住、Wait 节点问题 |
| 引入 TTS / 音频合成 | 当前 P0 已禁用，不要在稳定性未验证前恢复 |
| 做 SaaS / 多用户 / 计费系统 | 超出本地工具定位 |
| 把 prompt 只存在模型记忆里 | 模型无状态，必须自己管理上下文 |
| 在 P0 清除 Key 之前分发 workflow 文件 | Key 写死在 JSON 中，分发即泄露 |
| 恢复旧版 WF03（含 TTS / scene-audio） | 旧版已证明会引入 voiceover_audio_path / mp3 混乱 |

---

## 14. 需要人工确认的问题清单

以下问题需要用户或 Codex 在人工确认阶段决策：

### 14.1 关于 API Key 管理方式

**问题**：第一版给用户的 API Key 读取方式应该是：
- A. 继续用本地文件（`~/.n8n/{provider}-api-key`），和 ModelHub 保持一致
- B. 只用环境变量（`$env.XXX`），在 n8n 的 `.env` 文件里填写
- C. UI 配置页写入 `config.json`，workflow 从文件读取
- D. A + B 的 fallback 组合（当前 ModelHub 做法）

**建议**：D（组合 fallback），第一版可暂不做 UI 配置页，交付时附手动填写 Key 的说明文档。

### 14.2 关于 Prompt 存储位置

**问题**：Prompt 第一版应该存在：
- A. 外部 JSON 文件（类似 `tiktok-workflow-prompts.json`，所有 prompt 合并在一个文件）
- B. 每个 prompt 一个 txt 文件（类似当前 `prompts/` 目录，但需要 workflow 能加载）
- C. 保持在 Prompt Library Code 节点中，用 embed 脚本同步到文件

**建议**：A，统一到一个 `prompt_center.json`，workflow 用 `fs.readFileSync` 读取，用户编辑文件即可。

### 14.3 关于 NanoBanana 模型是否就是 Gemini 图像生成

**问题**：audit 发现 "NanoBanana" 实际上是调用 Gemini 图像模型（`gemini-3.1-flash-image-preview`）通过子进程方式执行，不是独立的 "NanoBanana" API。请确认：
- 当前 NanoBanana = Gemini 图像生成能力？
- 是否有独立的 NanoBanana 厂商 API，需要单独的 Key？

**影响**：影响 API Key 管理方案中是否需要区分"Gemini 文本 Key"和"Gemini 图像 Key"。

### 14.4 关于图片上传数量

**问题**：当前表单说"建议 2 张"，代码只处理 `image_1_path` / `image_2_path`。需求要求支持 0-5 张。请确认：
- 0 张（无图片）时，workflow 是否能只用文字信息运行？
- 还是 0 张是边缘用例，优先保证 1-5 张？

### 14.5 关于 WF01 的职责边界

**问题**：当前 WF01 实际上完成了创意方向生成 + 脚本生成 + NanoBanana 生图 + 裁切 + 打包，不只是"创意方向"。WF02 是另一个续跑入口（用户换方向时重跑）。这两个文件内部节点大量重复。
- 是否需要在重构中把 WF01 真正拆分为"01a: 创意方向"和"01b: 分镜"？
- 还是保持现状（WF01 一次完成全流程），只在换方向时走 WF02？

**建议**：保持现状，WF01 继续一次完成，WF02 专门用于"换方向后续跑"。这样改动最小，不破坏现有可运行版本。

### 14.6 关于视频合成

**问题**：当前没有最终视频合成逻辑（多镜头合成一个完整短视频）。用户需要手动找到各 shot 文件自己拼接。是否需要在第一阶段就做视频合成？
- 如果要做，使用 ffmpeg 合成；需要新增节点和 UI 按钮
- 如果暂时不做，交付时在文档说明用户如何手动合并

### 14.7 关于 serve-review-assets.mjs 的维护方式

**问题**：当前 UI 逻辑（`serve-review-assets.mjs`，约 2200 行）是纯 Node.js 手写 HTML，没有前端框架。后续 UI 增加功能（配置页、Prompt 编辑页、错误日志页）是继续在这个文件里写，还是要做一次前端框架迁移？
- 继续手写 HTML（快，不需要前端工程化，但代码可读性差）
- 迁移到简单框架（如 Express + 前端 HTML 文件分离）

**建议**：第一版继续手写 HTML，保证不破坏现有可运行版本；第二阶段视需求决定是否迁移。

### 14.8 关于 ai_runs 落盘的存储格式

**问题**：第一版 ai_runs 应该存在：
- A. 每次调用一个 JSON 文件（类似 `gemini-requests/` 现有做法）
- B. 每个 project 一个 JSON 文件（所有 stage 的 ai_run 记录合并）
- C. SQLite 表

**建议**：A（每次一个文件），和现有 `gemini-requests/` 结构一致，便于 debug，且对现有节点改动最小。

---

## 附录：关键文件路径索引

| 文件 | 用途 |
|------|------|
| `正式导入文件/01-主流程-表单到创意方向.json` | WF01 主流程（当前可运行版本） |
| `正式导入文件/02-续跑-创意方向到分镜.fixed-context.json` | WF02 续跑（推荐版本） |
| `正式导入文件/03-续跑-分镜审核到视频.simplified-v1.json` | WF03 视频生成（当前生产版本） |
| `serve-review-assets.mjs` | UI 工作台 HTTP 服务（约 2200 行） |
| `tiktok-workflow-prompts.json` | veo_repair prompt 文件（已被 WF03 读取） |
| `prompts/` | Prompt 参考文件（**未被 workflow 加载**，仅供参考） |
| `config/creative_task_type_mapping.json` | 创作任务类型配置 |
| `stability_check.mjs` | 健康检查脚本 |
| `repair_active_workflow_versions.mjs` | Webhook 修复脚本 |
| `.n8n-local-cache/concept-context/` | 创意方向上下文 JSON 文件 |
| `.n8n-local-cache/review-context/` | 分镜审核包 JSON 文件 |
| `.n8n-local-cache/review-progress/` | 视频生成进度 JSON 文件 |

---

## 审计结论

当前系统已具备一个可运行、三段式的 n8n 本地工作流骨架，上下文串联机制通过本地 JSON 文件实现，整体思路是正确的。

**最高优先级问题（阻塞交付）**：

1. **开发者 Gemini API Key 写死在 workflow JSON 中**（`nano banana` 节点 + WF03 HTTP 节点），分发给任何人都会直接泄露 Key。
2. **硬编码的 `/Users/drew/...` 路径**，换一台电脑就不能运行。

**第一阶段不触碰可运行版本、只做以下两件事即可让系统具备交付前提**：
1. 清除 Key 硬编码
2. 替换路径硬编码为相对路径或配置读取

其余需求（Prompt 模块化、ai_runs 落盘、UI 审查/重跑、0-5 张图片、视频合成）均可在第二阶段逐步实现，不影响当前可运行状态。

---

**本报告完成。等待人工与 Codex 确认后进入实际改造阶段。**
