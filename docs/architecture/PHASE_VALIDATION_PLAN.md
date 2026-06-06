# PHASE_VALIDATION_PLAN

这个文件定义每阶段结束时怎么验收、怎么回滚、Codex Review 看什么。

## 1. 通用停止规则

每个阶段结束必须停住，输出报告，等待用户确认。

任何阶段都不能默认生成候选包。只有用户明确批准 `PACKAGE-ONCE`，才允许生成新 RC / DMG。

任何阶段都不能默认触发真实模型。需要真实模型时必须在阶段说明里明确写出，并由用户单独确认。

## 2. 通用 Codex Review 清单

每阶段结束检查：

- 是否只改了本阶段允许的文件。
- 是否改了 workflow JSON。
- 是否改了 prompt。
- 是否改了 model route。
- 是否提交了产品表单。
- 是否调用 Gemini / Nano Banana / Veo。
- 是否新增 n8n execution。
- 是否生成 RC / DMG。
- 是否执行 codesign / hdiutil。
- 是否删除或移动运行数据。
- 是否写入 App 包内部。
- 是否新增 API Key、Bearer Token、Authorization、License 泄漏风险。
- 是否有明确回滚方式。

## 3. Phase 2 非付费测试建议

优先建立这些测试，不需要真实模型：

| 测试 | 目的 | 付费风险 |
| --- | --- | --- |
| `redact.test.mjs` | 敏感信息脱敏 | 无 |
| `safe-path.test.mjs` | 防路径穿越、防写 app 包、防写系统目录 | 无 |
| `stage-router.test.mjs` | 给 fixture，确认 active route | 无 |
| `project-state.test.mjs` | 读写 patch、reconcile、explicit error 不被降级 | 无 |
| `form-dedup.test.mjs` | 表单重复提交 key 与 TTL | 无 |
| `export-service.test.mjs` | copy/skip/no overwrite | 无 |
| `diagnostics-redaction.test.mjs` | 诊断包不泄露 Key | 无 |

注意：当前 `serve-review-assets.mjs` 模块加载会创建目录，且结尾会启动 server。非付费测试不要直接 import 它。先抽纯函数，或者用独立 fixture 复制逻辑后再迁移。

## 4. Phase 3 StageRouter 验收标准

给定同一个 `project_id`：

- 只有 `concept_context`：应显示创意方向。
- 有 `selected_concept` 但无 `script_context`：应显示脚本生成中或错误状态。
- 有 `script_context`：应显示脚本框架页。
- 有 `confirmed_script_context` 且无 `review_context`：应显示分镜生成中。
- 有 `review_context` 且无 submitted sidecar：应显示分镜审核页。
- 有 submitted sidecar 且 progress running：应显示视频生成状态页。
- progress shots 全部完成：应显示视频/final 阶段。
- final 文件存在：应优先 final。
- exported 文件存在：可显示 exported，但不能挡住 final 查看。
- explicit error stage，如 `script_failed` / `storyboard_failed`：不能被普通 artifact derive 降级覆盖。

## 5. Phase 4 Artifact / Export 验收标准

- 所有用户数据写入用户数据目录或用户选择输出目录。
- 不写入 `.app/Contents/Resources`。
- project_id 必须校验。
- 文件复制不能覆盖不同大小的同名文件。
- 已存在同大小文件应 skip。
- final 查找优先级明确：最新 internal final、用户输出 final、export summary。
- 路径越权测试通过。

## 6. Phase 5 Diagnostics 验收标准

- `GET /api/env-status` 只读，不写 project state，不自动 export。
- `GET /api/export-diagnostics` 才写诊断文件。
- 诊断包中 API Key、Authorization、Bearer、License、token 全部脱敏。
- n8n execution 摘要默认只出必要字段，不输出完整 raw data。
- 错误不能静默吞掉，至少进入 logger。

## 7. Phase 6 PlatformService 验收标准

- Mac 当前 choose directory、open folder 行为不变。
- 业务层不直接调用 `osascript`、`/usr/bin/open`、`ioreg`。
- `getUserDataDir()`、`getWorkflowDataRoot()`、`getLogsDir()`、`getConfigPath()` 有统一入口。
- Windows 只做接口和占位实现，不进入完整 Windows 打包。

## 8. PACKAGE-ONCE 前置条件

只有这些条件都满足，才建议用户批准 PACKAGE-ONCE：

- Phase 2-6 的非付费测试通过。
- Mac source/dev smoke 通过。
- n8n execution count 没有因测试误增。
- workflow hash 与基线一致，除非用户明确批准 workflow 变更。
- prompt hash 与基线一致，除非用户明确批准 prompt 变更。
- model route 与基线一致。
- 没有写 App 包内部。
- 诊断包脱敏验证通过。
- Codex Review 明确通过。

