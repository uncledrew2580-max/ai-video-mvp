# MODULE_MAP

目标：把 `版本测试/serve-review-assets.mjs` 的职责拆开看清楚，先画地图，再决定每一步抽离顺序。

## 1. 巨石文件职责地图

| 模块 | 主要函数 | 主要 route | 读取文件 | 写入文件 | 外部命令 / n8n | 当前风险 | 第一批抽离建议 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Form / 产品提交 | `renderProductFormPage`, `parseMultipartForm`, `validateProductSubmissionParts`, `buildSubmitDedupKey`, `submitProductToN8n` | `GET /new-project`, `POST /submit-product`, `GET /submitted` | config、上传 multipart body | 无直接保存上传文件，由 n8n 后续写缓存；可能写默认输出目录配置 | `fetch(getN8nFormUrl())` 到 WF01 form webhook；SQLite 查 form webhookPath | 手写 multipart，不够稳；去重只在内存 30 秒；输出目录检查会写 `.write_test`；失败日志不统一 | Phase 4 抽。Phase 2 先给 parser/dedup 做非付费测试 |
| 创意方向 | `renderConceptListPage`, `renderConceptDetailPage`, `renderConceptStatusPage`, `rerunDirectorConcepts`, `normalizeDirectorConcepts`, `saveConceptRevisionState`, `updateSelectedConceptSidecar` | `GET /concepts`, `GET /concepts/item`, `GET /concept-status`, `POST /concept-select`, `POST /concept-select-with-edit`, `POST /concept-revision-save`, `POST /concept-feedback`, `GET /api/concept-poll` | `concept-context`, `selected-concepts`, `concept-revisions`, `project-notes`, prompt center, mapping, product images | `selected_concept_*.json`, `concept_revisions_*.json`, `project-feedback`, text model request/response, concept context, project state | `fetch` WF02a webhook；`curl`/`gemini-generate.mjs` direct model call for concept rerun | 直接模型调用绕过 n8n；上下游 stale 标记与选择提交耦合；重跑会写多类文件 | Phase 3 只接 StageRouter；业务逻辑 Phase 7 后再动 |
| 脚本框架 | `renderScriptReviewPage`, `renderScriptReviewLegacyPage`, `buildConfirmedScriptContext`, `confirmedScriptContextPath` | `GET /script-review`, `POST /script-shot-save`, `POST /script-confirm` | `script-context`, `script_user_overrides`, `concept-context`, `review-context` legacy | `script_user_overrides_*.json`, `confirmed_script_context_*.json`, `script_context_*.json`, project state | `fetch` WF02b webhook after confirm | 当前用户问题集中在“脚本已生成但 UI 未自动展示”；确认脚本会 stale 下游并触发分镜 | Phase 3 优先。需要先让 StageRouter 明确 `script_context` 存在时跳 `/script-review` |
| 分镜生成 / 分镜审核 | `renderStoryboardStatusPage`, `renderReviewListPage`, `renderReviewDetailPage`, `readPendingReviews`, `getLatestReviewContextFileForProject` | `GET /storyboard-status`, `GET /reviews`, `GET /reviews.json`, `GET /reviews/context`, `GET /reviews/item`, `GET /api/storyboard-poll` | `review-context`, `nanobanana`, `分镜图裁剪`, `project-state`, n8n execution | 状态查询可能写 `project-state` | SQLite execution 查询；WF02b 状态推导 | `review_context_missing` 有恢复提示，但状态与路由散落；stale/submitted 过滤规则容易错 | Phase 3 路由优先；Phase 4 产物存储再整理 |
| 视频生成 / 单镜头重做 | `forwardReviewSubmission`, `renderReviewStatusPage`, `readProgressFile`, `hydrateProgressFromExecutionError`, `readActiveRerunShotLock`, `writeRerunShotLock` | `POST /review-submit`, `POST /review-rerun-failed`, `POST /review-rerun-shot`, `POST /review-rerun-pending`, `POST /review-pause-project`, `GET /review-status` | `review-context`, `review-progress`, `submitted sidecar`, n8n execution, videos | `.submitted.json`, `review_progress_*.json`, rerun lock, project state, stale files | `fetch` WF03 webhook；SQLite execution 查询 | 这是扣费高风险区。已有 guard，但散落在 route 中，非持久去重和 sidecar 状态容易被污染 | Phase 3/4。先统一状态，再抽 dedup/lock |
| final / 导出 | `renderFinalVideoPage`, `resolveFinalOutputDisplay`, `exportProjectArtifacts` | `GET /final-video`, `POST /api/export-project` | `review-progress`, `final-video`, configured output dirs, project state | 用户输出目录、project state export summary | `/usr/bin/open` 在 output action；无模型 | `collectEnvStatus()` 可自动 export，状态页不是纯读；final 与 exported 状态容易互相覆盖 | Phase 4 抽 ArtifactStore/ExportService |
| 项目管理 | `renderCurrentProjectPage`, `buildProjectDashboard`, `buildRunContextSummary`, `readProjectNotes`, `saveProjectNotes`, `appendProjectFeedback`, `syncProjectHistory` | `GET /active`, `POST /project-notes-save` | `project-state`, notes, feedback, concept/review/script/progress | `project-notes`, `project-feedback`, `project-history` | 无模型；间接读 n8n execution | `syncProjectHistory()` 会写历史文件；项目页内嵌多段 reconcile JS | Phase 3 后再抽 ProjectService facade |
| 项目状态推导 | `readProjectState`, `updateProjectState`, `deriveProjectStatusFromArtifacts`, `deriveProjectStage`, `mergeDerivedProjectStateForUi`, `getActiveRoute`, `markDownstreamStale` | `POST /api/reconcile-project`，多个页面内联调用 | project state、script/review/progress/final/output artifacts、n8n execution | project state、stale 目录、移动旧产物 | SQLite execution 查询 | 当前最高风险模块。状态推导、写回、路由和 stale 移动混在一起 | Phase 3 第一核心模块 |
| n8n execution 查询 | `queryRecentExecutions`, `findLatestExecutionForProject`, `findLatestWF01Execution`, `readExecutionErrorSummary`, `readExecutionDataSummary`, `buildExecutionDetailSummary` | `/api/wf01-status`, `/api/storyboard-poll`, diagnostics, status pages | n8n SQLite `execution_entity`, `execution_data`, `workflow_entity` | 一般不写，但错误 hydrate 会写 progress/state | `sqlite3` CLI | SQL 拼接分散；读取 execution raw data 容易泄露敏感信息；依赖本机 sqlite3 | Phase 5/7 抽 `n8nService` |
| 配置 / API Key | `loadConfig`, `saveConfig`, `normalizeAiConfig`, `applyKieConstants`, `getTextModelConfig`, `apiKeyConfigured` | `GET /config`, `POST /config-save`, `POST /test-connection` | App Support config、bundle seed config | config tmp/rename，默认输出目录配置 | `curl` Kie recordInfo test；n8n health | 配置读取会 seed/copy；测试连接外呼 Kie；脱敏不统一 | Phase 2 logger/redact；Phase 5 diagnostics |
| 输出目录 / 文件打开 | `chooseDirectoryWithSystemDialog`, `expandPath`, `isOutputPathSafe`, `checkOutputPathStatus`, `ensureDefaultOutputDirs` | `POST /choose-directory`, `POST /api/output-folder-action` | config、filesystem | output dirs、config、`.write_test` | `osascript`, `/usr/bin/open` | macOS 写死；输出路径安全规则分散；状态检查会写测试文件 | Phase 6 PlatformService，Phase 4 ExportService |
| 诊断 / env-status | `collectEnvStatus`, `renderSystemPage`, `envAction` frontend, diagnostics block | `GET /system`, `GET /api/env-status`, `POST /api/env-action`, `GET /api/export-diagnostics` | config、logs、cache、n8n DB、workflow cache、project state | diagnostics JSON、可能写 project state、可能自动 export、可能清理/重置 | `sqlite3`, `hostname`, `sw_vers`, n8n health, sync script, kill process | 诊断不是纯读；维护动作很重；日志脱敏较散 | Phase 5，先提供只读 diagnostics snapshot |
| prompt 读取 | `loadPromptCenter`, `_isStalePromptCenter`, `_logPromptMigration`, `savePromptModule`, `resetPromptModule`, `renderPromptCenterPage` | `GET/POST /prompt-center`, `/prompt-center-reset` | prompt center seed/example/App Support prompt | prompt center、backup、prompt migration log | 无模型；概念重跑读取 prompt | App 启动时 dist 会自动 prompt migration，可能改用户 prompt | Phase 9，当前不要动 prompt |
| 安全 / 路径校验 | `safeJoin`, `isAllowedLocalAssetPath`, `normalizeReviewContextPath`, `getContextPathFromRequestUrl`, `getConceptContextPathFromRequestUrl`, `isOutputPathSafe` | `/local-file`, static fallback, review/concept routes | path query 参数 | 无直接写，间接影响读写目标 | 无 | 部分路径仅 basename 检查，部分用绝对 path；策略不统一 | Phase 2 抽 pure safe path tests；Phase 4/6 落地 |
| UI 模板渲染 | `commonCSS`, `renderStageNav`, `renderHubPage`, `renderProductFormPage`, `renderConfigPage`, all `render*Page` | 几乎所有 GET route | config、project artifacts、contexts | 通过调用状态函数可能间接写 | 无 | HTML、CSS、业务状态、前端脚本混在模板字符串中，改 UI 容易改坏业务 | Phase 8。不要第一批拆 |
| 前端 JS 交互 | 内嵌在 render 函数里的 `fetch('/api/...')` 片段 | `/submitted`, `/active`, `/script-review`, `/review-status`, `/system`, `/final-video` | API JSON | 用户操作触发写 | 调用本地 API | 重复 reconcile/poll 逻辑，错误提示不统一，刷新机制不稳定 | Phase 3 定义 StageRouter API 后再整理 |
| 错误处理 / 日志 | `redactSensitiveText`, route-level `catch`, diagnostics redact | 所有 route | execution/log/config | diagnostics、prompt migration log | 无统一 logger | 大量 `catch {}` 静默吞错；返回给用户和写日志不一致 | Phase 2 优先 |
| License / 激活 | `getDeviceId`, `readLicenseRecord`, `verifySignedLicenseCode`, `getLicenseStatus`, `saveLicenseRecord`, `renderActivationPage` | `/activate`, `/license/status` | license file、device id | license JSON | `ioreg` | macOS 设备 ID 写死；商业交付重要，但和当前视频流程解耦 | 后续独立，不放第一批 |

## 2. 当前 route 分布

高层页面：

- `/` 工作台首页
- `/new-project` 产品表单
- `/submitted` 提交等待页
- `/active` 当前项目页
- `/concepts`, `/concepts/item`, `/concept-status`
- `/script-review`
- `/storyboard-status`
- `/reviews`, `/reviews/item`, `/review-status`
- `/final-video`
- `/config`
- `/system`
- `/docs`
- `/activate`

写操作：

- `/submit-product`
- `/concept-select`, `/concept-select-with-edit`, `/concept-revision-save`, `/concept-feedback`
- `/project-notes-save`
- `/review-submit`, `/review-rerun-failed`, `/review-rerun-shot`, `/review-rerun-pending`, `/review-pause-project`
- `/script-shot-save`, `/script-confirm`
- `/config-save`, `/choose-directory`, `/api/output-folder-action`, `/api/export-project`
- `/api/reconcile-project`
- `/api/env-action`, `/api/export-diagnostics`, `/reset-test-data`
- `/prompt-center-save`, `/prompt-center-reset`
- `/activate`

只读/轮询接口名义上只读，但需要复核副作用：

- `/api/env-status` 会调用 `collectEnvStatus()`，可能写 state 或 export。
- `/system` 同上。
- `/api/wf01-status` 在失败时可能写 project state。
- `/api/storyboard-poll` 在 WF02B 错误时可能写 project state。

## 3. 推荐目标模块架构

建议目标目录：

```text
app-server/
  server.mjs
  routes/
    form.routes.mjs
    concept.routes.mjs
    script.routes.mjs
    storyboard.routes.mjs
    review.routes.mjs
    final.routes.mjs
    config.routes.mjs
    system.routes.mjs
  services/
    ProjectStateService.mjs
    StageRouter.mjs
    ArtifactStore.mjs
    WorkflowAdapter.mjs
    N8nService.mjs
    DiagnosticsService.mjs
    ConfigService.mjs
    PromptCenterService.mjs
    PlatformService.mjs
    Logger.mjs
  repositories/
    JsonFileStore.mjs
    N8nSqliteStore.mjs
  ui/
    templates/
      layout.mjs
      stage-nav.mjs
      pages/
  contracts/
    project-state.schema.json
    workflow-payloads.md
    route-map.md
  tests/
    nonpaid/
      redact.test.mjs
      safe-path.test.mjs
      stage-router.test.mjs
      project-state.test.mjs
      form-submit-dedup.test.mjs
      export-service.test.mjs
```

## 4. 迁移归属建议

进入 `routes/`：

- 只保留 HTTP method/path、参数解析、调用 service、写 response。
- 首批不要抽所有 routes。先在 Phase 3 新增 `StageRouter` 后，让 `/active`、`/api/reconcile-project`、`/api/concept-poll`、`/api/storyboard-poll` 接入。

进入 `services/`：

- `ProjectStateService`：`readProjectState`, `updateProjectState`, `deriveProjectStage`, `mergeDerivedProjectStateForUi`, `markDownstreamStale`
- `StageRouter`：`getActiveRoute`, `getLatestConceptContextFileForProject`, `getLatestReviewContextFileForProject`, `progressSidecarPath` 的只读部分
- `ArtifactStore`：cache/output/final/video/storyboard 文件定位和 export
- `WorkflowAdapter / N8nService`：所有 SQLite 查询、webhook resolve、webhook forward、n8n health
- `ConfigService`：load/save/normalize config
- `DiagnosticsService`：env status、diagnostics bundle、redaction
- `PlatformService`：`chooseDirectoryWithSystemDialog`, `openFolder`, `getUserDataDir`, `killOwnedProcess`

进入 `ui/templates/`：

- `commonCSS`, `renderStageNav`, 所有 `render*Page`
- 但它们应在服务层稳定后再拆，避免 UI 拆分和状态修复混在一起。

进入 `contracts/`：

- `project_state` 可见状态枚举
- `script_context`, `review_context`, `review_progress`, `.submitted.json` 的字段说明
- n8n webhook payload contract：保持字段不变，只记录，不重命名

进入 `tests/nonpaid/`：

- `redactSensitiveText` / logger redaction
- path safe checks
- stage router fixture tests
- project state reconcile fixture tests
- form parser/dedup unit tests
- export idempotency tests

暂时不要动：

- prompt 内容
- workflow 主骨架
- model route
- n8n webhook 字段
- Electron launcher
- packaging scripts
- candidate packages

