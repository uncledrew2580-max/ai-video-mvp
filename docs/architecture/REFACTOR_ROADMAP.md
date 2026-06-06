# REFACTOR_ROADMAP

原则：不推倒重写，不一次性拆完。每阶段只动一个模块，结束必须停住，交报告，Codex Review 通过后再进下一阶段。

## P0：冻结基线与测试基线

- 目标：明确“从哪里开始”，包括源码、候选包、workflow/prompt/hash、n8n execution count。
- 改哪些文件：只允许 `docs/architecture/*`。
- 不改哪些文件：所有运行时代码、workflow、prompt、config、release-candidates。
- 风险点：如果没有 Git，后续回滚只能靠文件 hash 和备份。
- 非付费验证：重复 hash；n8n execution count/max 不变；端口归属不变。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：删除本阶段新增文档。
- Gate：Codex 确认无代码改动、无模型调用、无新增 execution、无 RC/DMG。

## P1：Logger / 脱敏日志

- 目标：新增统一脱敏工具和 logger，不迁移业务逻辑。
- 改哪些文件：新增 `app-server/services/Logger.mjs` 或 `app-server/shared/redact.mjs`；新增 `tests/nonpaid/redact.test.mjs`。
- 不改哪些文件：`serve-review-assets.mjs` 主流程暂不接入；workflow/prompt/model route 不动。
- 风险点：脱敏规则过严会影响诊断可读性，过松会泄露 Key。
- 非付费验证：给 Authorization、Bearer、Kie key、OpenAI sk、Google AIza、license/token 样例跑测试。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：删除新增 logger/redact/test 文件。
- Gate：测试通过；不影响启动；不触发 n8n execution。

## P2：ProjectStateService + StageRouter

- 目标：把“项目现在到哪一步”和“用户下一步去哪”统一成可测试模块。
- 改哪些文件：新增 `ProjectStateService.mjs`, `StageRouter.mjs`, fixtures/tests；小范围让 `/active`、`/api/reconcile-project`、poll endpoint 调用 facade。
- 不改哪些文件：workflow/prompt/model route；不改表单字段；不改视频生成 webhook。
- 风险点：路由优先级改错会让已生成项目跳错页。
- 非付费验证：fixture 覆盖 creative、script_context、confirmed_script、review_context、submitted、progress done、final、exported、failed。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：恢复被接入的少量 route 调用，保留或删除新增服务。
- Gate：脚本存在时 active route 必到 `/script-review`；review_context 存在时到分镜审核；final 存在时优先 final/export。

## P3：Form submit / upload / dedup

- 目标：稳定用户入口，减少重复提交扣费风险。
- 改哪些文件：Form route、上传解析工具、dedup store、非付费测试。
- 不改哪些文件：WF01 payload 字段不变；图片输入不移除；模型不变。
- 风险点：解析 multipart 改错会导致图片传不到 n8n。
- 非付费验证：multipart fixture；0/1/5/6 张图片；超大图片；重复提交；App 重启后 dedup 策略。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：回退 Form route 和 parser 文件。
- Gate：所有非付费上传/去重测试通过；payload 字段快照不变。

## P4：ArtifactStore / output export

- 目标：统一产品图、分镜图、视频、final、导出目录的读写边界。
- 改哪些文件：新增 `ArtifactStore`, `ExportService`；小范围接 `/api/export-project` 和 final display。
- 不改哪些文件：n8n 产物命名暂不改；workflow 不改。
- 风险点：文件匹配规则改错会漏导出或导出旧文件。
- 非付费验证：用本地 fixture 文件测试 copy/skip/no-overwrite/final priority。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：恢复原 `exportProjectArtifacts` 调用。
- Gate：导出幂等；不会写 app 包内部；路径越权测试通过。

## P5：DiagnosticsService

- 目标：诊断包和环境状态变成可控服务，支持只读快照。
- 改哪些文件：新增 `DiagnosticsService`；接 `/api/env-status`, `/system`, `/api/export-diagnostics`。
- 不改哪些文件：不改 n8n workflow，不改生成链路。
- 风险点：当前 `collectEnvStatus()` 有写副作用，迁移时要分成 read-only status 和 repair action。
- 非付费验证：脱敏、日志尾部、端口摘要、execution 摘要、只读模式不写文件。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：恢复原 env-status/diagnostics route。
- Gate：只读 status 不写 project state；导出诊断才写 diagnostics 文件；敏感信息不泄漏。

## P6：PlatformService

- 目标：收口 macOS/Windows 差异，不让业务层继续写死系统命令。
- 改哪些文件：新增 `PlatformService`；接目录选择、打开文件夹、用户数据目录、logs/config/workflow paths、kill owned process。
- 不改哪些文件：Electron launcher 暂不大改；Windows 完整版不做。
- 风险点：Mac 当前行为不能变；Windows 只提供接口和占位实现。
- 非付费验证：Mac path resolution tests；命令 adapter mock tests。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：恢复原 `osascript`/`open` 调用。
- Gate：Mac 功能等价；业务代码不直接调用 `osascript`/`open`。

## P7：n8nService / WorkflowAdapter

- 目标：收口 n8n DB 查询、webhook resolve、health check、workflow sync 状态。
- 改哪些文件：新增 `N8nService`, `WorkflowAdapter`; 小范围替换 execution 查询和 webhook resolve。
- 不改哪些文件：不改 workflow JSON 字段和语义。
- 风险点：webhook resolve 改错会导致主流程断。
- 非付费验证：SQLite fixture 或 readonly test DB；webhook path query fixture；health check mock。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：恢复原 direct SQLite/fetch 调用。
- Gate：不新增 execution；查询结果与原函数一致；workflow hash 不变。

## P8：UI templates 拆分

- 目标：把 HTML/CSS/前端 JS 模板从 service 中拆开，降低 UI 修改风险。
- 改哪些文件：`ui/templates/*`；routes 只引用模板函数。
- 不改哪些文件：状态推导、n8n、workflow、prompt 不动。
- 风险点：大面积字符串移动容易引入漏转义或按钮失效。
- 非付费验证：HTML snapshot；核心页面能打开；按钮 URL 不变。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：恢复模板移动 commit。
- Gate：页面 route 和表单 action 快照不变。

## P9：PromptCenterService / Prompt 模块化

- 目标：收口 prompt 读取、seed、migration、内部 prompt center。
- 改哪些文件：Prompt service 和 prompt center routes。
- 不改哪些文件：prompt 内容不改，model route 不改。
- 风险点：启动时自动 migration 可能改用户 prompt，需要显式化。
- 非付费验证：seed/migration fixture；App Support prompt 不意外覆盖。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：否。
- 回滚方式：恢复 prompt loader 调用。
- Gate：prompt hash 不变；内部 prompt center 正式版仍隐藏。

## P10：Windows PlatformService

- 目标：在 Mac 稳定后补 Windows 平台实现。
- 改哪些文件：PlatformService Windows adapter、packaging 准备文档。
- 不改哪些文件：业务流程、workflow、prompt、model route 不动。
- 风险点：Windows n8n/sqlite/node runtime 打包需要单独干净机验证。
- 非付费验证：Windows path unit tests；不依赖系统 Node/n8n/sqlite3/curl。
- 是否需要真实模型：否。
- 是否需要 PACKAGE-ONCE：后续 Windows 包需要，当前否。
- 回滚方式：禁用 Windows adapter，保留 Mac。
- Gate：Mac 不回退；Windows basic runtime smoke 通过后再考虑候选包。

## 现在不要做

- 不要现在重写整个 App。
- 不要现在替换 n8n。
- 不要现在同步开发 Windows 完整版。
- 不要现在大改 prompt。
- 不要现在重构 workflow 主骨架。
- 不要现在一次性拆完所有 routes。
- 不要现在改模型供应商。
- 不要现在改变文件格式。
- 不要现在改变用户主流程。
- 不要现在生成新的 RC / DMG。

## 第一个真正可执行小任务

推荐任务：建立脱敏工具和非付费测试。

交付边界：

- 新增 `app-server/shared/redact.mjs`，导出 `redactSensitiveText(value)`。
- 新增 `tests/nonpaid/redact.test.mjs`。
- 暂不改 `serve-review-assets.mjs` 调用。
- 测试覆盖 Authorization、Bearer、Kie token、OpenAI `sk-`、Google `AIza`、license/token、普通文本保留。

为什么是它：

- 不影响主流程。
- 不触发模型。
- 不触发 n8n execution。
- 不改 workflow/prompt/model route。
- 对后续 logger 和 diagnostics 都有直接价值。

回滚：

- 删除新增工具和测试文件即可。

