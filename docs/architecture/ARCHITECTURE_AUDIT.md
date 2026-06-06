# ARCH-P0-P1-READONLY-AUDIT

审计时间：2026-06-03，Asia/Shanghai

审计边界：

- 本轮只执行 Phase 0 + Phase 1。
- 已做：只读读取源码、目录、package/config/prompt/workflow 哈希、运行进程、端口、n8n execution 基线。
- 已写：仅新增 `docs/architecture/` 下的架构审计文档。
- 未做：未改运行时代码，未改 workflow，未改 prompt，未改 model route，未提交表单，未调用 Gemini/Nano Banana/Veo，未打包，未 codesign，未 hdiutil，未删除或移动文件。

## 1. 人话总结

这个项目已经能形成 Mac 本地闭环，但现在最危险的不是某一个按钮 bug，而是“状态、路由、文件产物、n8n 查询、UI 模板、诊断、配置”都挤在一个 8723 行文件里。用户看到的“脚本生成了但页面不自动显示”“final 页面显示旧阶段”“状态要点 tab 才刷新”，本质都是同一个问题：项目状态和页面跳转没有一个独立、可信、可测试的中心。

建议不要推倒重写。先把纯工具和测试地基建起来，再优先抽 `ProjectStateService + StageRouter`。这两个模块是商业交付稳定性的核心，因为它们决定用户到底该看到创意、脚本、分镜、视频、final 还是错误恢复页。

## 2. 当前基线快照

### 2.1 源码与关键文件

| 项目 | 当前值 |
| --- | --- |
| 源码根目录 | `/Users/drew/Downloads/tiktok-n8n-workflow-pack` |
| Git 状态 | 当前目录不是 Git repository，`git status` 返回 `fatal: not a git repository` |
| 活跃巨石文件 | `/Users/drew/Downloads/tiktok-n8n-workflow-pack/版本测试/serve-review-assets.mjs` |
| 巨石文件行数 | 8723 行 |
| 巨石文件 SHA-256 | `69981719a8cb047e980c8bff2e6cf1b3a8d53b911e1b8b3a39b33f028cdde0ed` |
| Electron main | `/Users/drew/Downloads/tiktok-n8n-workflow-pack/desktop/main.cjs` |
| Electron main SHA-256 | `7b7ea2705e139335ed781e4847d326b7b840da3de5e14c6ea239c989454808eb` |
| Launcher | `/Users/drew/Downloads/tiktok-n8n-workflow-pack/client/launcher.mjs` |
| Launcher SHA-256 | `1769628053e29fd01ed394a30e4119732bf8ed0ec7b3c8d8823c822efd895e8a` |
| workflow sync script | `/Users/drew/Downloads/tiktok-n8n-workflow-pack/sync_iteration_v1_workflows_to_db.mjs` |
| sync script SHA-256 | `d2a70387374d57395dc10ca70e0239e8b940a47c24a116e3a8187c09678ac641` |
| package.json SHA-256 | `885d440727f65e0801dfd28737775273bb4fa343779cbbbe472df6eef6157d58` |

### 2.2 当前 canonical workflow hash

同步脚本声明 canonical workflow 来源为：

`/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/`

| workflow | 文件 | SHA-256 |
| --- | --- | --- |
| WF01 | `n8n01.json` | `7b9a71dca0d050c682e437f05d45e59897a5b0e554d85e86209a82749387de98` |
| WF02 | `n8n02.json` | `c0e82fcd2ad739394c5e5d58b9816b081c814f2ac64a6e353f5ee909363026e1` |
| WF02a | `n8n02a.json` | `fffdf40dd66ecfac7c692bf1e66e72646ccbec6aa024146aa26d0e9242d67901` |
| WF02b | `n8n02b.json` | `318d8ec15630471fc9d61e83039d51606daa9fe12783e1176c3623aa421bba8a` |
| WF03 | `n8n03.json` | `d21cc326218f4bcca91f674c99a8b35c74ba7177c44965f08af60691e7d38844` |
| n8n04 | `n8n04.json` | `c25eebf75d12c0b436ba8553d35128627a7bb814d42f6b45577e9bbe5f6cf54a` |

额外历史/兼容 workflow 文件仍在 `正式导入文件/` 根目录，但同步脚本当前主线是 `iteration-v1`。

### 2.3 prompt / model route / config hash

| 文件 | SHA-256 |
| --- | --- |
| `prompts/00_director_system_prompt.txt` | `9ea2504225dfed196a4dd9fb58af3abe27bb605d1e5e847854b67f6aeb19375d` |
| `prompts/01_concept_generation_prompt.txt` | `f53a16b29eea63c15f5edbed7d6df81478f93958872be4ebb2ec865c2b97d76f` |
| `prompts/02_script_table_prompt.txt` | `45af44fbaab37ea674e971690362d7a5de407855ccdbf5b72639c3428dc6bdb0` |
| `prompts/03_nanobanana_storyboard_prompt.txt` | `4e936b9bbd184f2eedfd0e09ebf7ea6f4e14ab4c7dffd83ab47cf2f44f915796` |
| `prompts/04_video_clip_prompt.txt` | `105f72cb2cc8587b7d66df6e8a30c9a70ab6997a51d8feb1ac0ea03d0c76b56d` |
| `prompts/05_voiceover_prompt.txt` | `d34f9256c6382250a9766b876d1fc0de94bf87904ccde16bddc59a3d3a0b615c` |
| `prompts/consistency_rules_prompt.txt` | `5a424e110510d831c0bf1b736bca03386e30fef85e1f02639844d6b63b5eb546` |
| `prompts/localization_rules_prompt.txt` | `9224292c2ca6aedaa55ff07107c361b0cc388c33679411c779c239cf54e49704` |
| `prompts/negative_prompt_common.txt` | `e8372cd84b2069a0de14cbd614f3532fc494938e96a2e9c361cff9069331cfcd` |
| `prompts/prompt_center.json` | `6b5c5fe28ca8b48b3f65ba4f030d51f0783aeeb874558e0e06d606e8dfc3614e` |
| `prompts/prompt_center.example.json` | `11b0e9ca27109021a30d7a8579d18abccc5d61800c1461e4e9d9ac93ad8d2daf` |
| `prompts/tuning-fields.json` | `d0a28510321313c00180dd694d12fd9209b80a23a61bbb357660478d8cc996be` |
| `config/creative_task_type_mapping.json` | `7490bb14a15d5091238c2962cf693aaec1274771179143ed3f29d7a85f623515` |
| `config/local-config.json` | `b418a4b31dd27aeae5291b1e7578a54660a5b8aaba645b08f7c010cc4f3e211a` |
| `config/local-config.example.json` | `f89b1c7060a030b60d4ed54e2945f0d3a1844887ca2119344dafac9d0f71f346` |
| `prompt-module-loader.mjs` | `50a9724539d73c3bc48cd789e47df960322571cbedbf481d1296f13919eda4ba` |

当前代码中 model route 锁定方向：

- 文本：Kie OpenAI-compatible chat route，默认 `gemini-3.1-pro`。
- 图片：Kie market image route，默认 `nano-banana-pro`。
- 视频：Kie Veo route，默认 `veo3_lite`。

本轮未修改这些 route。

### 2.4 package scripts

| script | 命令 |
| --- | --- |
| `start:client` | `node client/launcher.mjs` |
| `desktop:dev` | `electron .` |
| `desktop:pack:mac` | `electron-builder --mac dir` |
| `desktop:pack:mac:manual` | `node scripts/package-ai-video-mac-app.mjs` |
| `package:mac:mvp` | `node scripts/package-mac-mvp.mjs` |
| `test` | `node --check client/launcher.mjs && node --check desktop/main.cjs && node --check 版本测试/serve-review-assets.mjs` |

本轮未运行 `npm test`，因为当前阶段要求只读，且测试脚本虽然只做 syntax check，但仍不是本阶段必需动作。

### 2.5 当前候选包

最新候选目录：

`/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260603-0002`

包含：

- App：`/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260603-0002/AI Video.app`
- DMG：`/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260603-0002/AI-Video-Mac-MVP-20260603-0002.dmg`
- DMG SHA-256：`cf5b373e6b49c638d5bab0e4190c409488ec7d0e44c9f3afdbb0c5e474f2cc3c`
- DMG mtime/size：2026-06-03 01:09:32，1619153584 bytes
- Info.plist：`CFBundleIdentifier=com.aivideo.workbench`，`CFBundleShortVersionString=1.0.0`

### 2.6 当前用户数据与运行路径

当前运行候选包使用的关键用户数据目录：

| 项目 | 当前路径 |
| --- | --- |
| 用户数据根 | `/Users/drew/Library/Application Support/AI Video` |
| config | `/Users/drew/Library/Application Support/AI Video/config/local-config.json` |
| workflow-data | `/Users/drew/Library/Application Support/AI Video/workflow-data` |
| cache root | `/Users/drew/Library/Application Support/AI Video/workflow-data/.n8n-local-cache` |
| logs | `/Users/drew/Library/Application Support/AI Video/logs` |
| launcher logs | `/Users/drew/Library/Application Support/AI Video/logs/launcher` |
| diagnostics logs | `/Users/drew/Library/Application Support/AI Video/logs/diagnostics` |
| n8n DB | `/Users/drew/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite` |

### 2.7 当前 n8n execution 基线

只读 SQLite 查询结果：

- `execution_entity` count：87
- max id：87
- 最近 5 条：
  - 87 `storyboardGenerateV1` success，2026-06-02 18:06:36.470 到 18:08:20.146
  - 86 `scriptGenerateV1` success，2026-06-02 18:00:34.666 到 18:01:13.591
  - 85 `rKHHjD2QBlL6EhaM` success，2026-06-02 17:59:33.252 到 18:00:09.764
  - 84 `reviewSubmitVeoV2` success，2026-06-02 17:45:52.342 到 17:47:17.385
  - 83 `reviewSubmitVeoV2` success，2026-06-02 17:32:27.644 到 17:43:41.335

本轮没有通过 webhook 或 UI 提交生成任务。结束前需再次复核 count/max 是否仍为 87/87。

### 2.8 当前运行进程与端口

当前运行中的候选包进程：

| PID | 角色 | 命令摘要 |
| --- | --- | --- |
| 28570 | Electron App | `.../AI Video.app/Contents/MacOS/Electron` |
| 28945 | Launcher | `.../Resources/app/bin/node .../client/launcher.mjs --no-browser` |
| 29452 | n8n | `.../Resources/app/bin/node .../node_modules/n8n/bin/n8n start` |
| 29464 | n8n task runner | `node .../@n8n/task-runner/dist/start.js` |
| 29478 | Local API/UI server | `.../Resources/app/bin/node serve-review-assets.mjs` |

端口归属：

- `127.0.0.1:18788`：PID 29478，`serve-review-assets.mjs`
- `127.0.0.1:5678`：PID 29452，n8n

### 2.9 当前禁止修改清单

本基线冻结后，未进入下一阶段前禁止修改：

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/版本测试/serve-review-assets.mjs`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/desktop/main.cjs`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/client/launcher.mjs`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/sync_iteration_v1_workflows_to_db.mjs`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/*.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/prompts/*`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/config/*`
- `/Users/drew/Library/Application Support/AI Video/**`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/**`

例外：本轮只允许写 `docs/architecture/` 下的审计文档。

## 3. 当前最高风险点

| 风险 | 等级 | 影响 Mac 当前交付 | 当前阶段必须修 | 建议处理阶段 | 人话解释 |
| --- | --- | --- | --- | --- | --- |
| 重复提交 / 重复扣费 | P0 | 是 | 否，本阶段只登记 | Phase 3/4 | 已有 30 秒内存去重、review submitted sidecar 和单镜头 lock，但分散且非持久。App 重启、并发点击、跨页面重试仍有风险。 |
| 状态流不一致 | P0 | 是 | 否，本阶段只审计 | Phase 3 | `project_state`、`script_context`、`review_context`、`review_progress`、final 文件共同决定页面，但没有统一状态服务。 |
| final 已生成但 UI 显示旧阶段 | P0 | 是 | 否，本阶段只审计 | Phase 3 | `deriveProjectStage()` 能识别 final，但路由优先级和状态写回分散，刷新时机不稳定。 |
| `review_context` / `.submitted.json` 污染 | P1 | 是 | 否 | Phase 3/4 | submitted sidecar、stale 文件、原 review_context 都放在相近目录和命名体系里，清理和扫描规则容易误判。 |
| API Key 泄露 | P0 | 是 | 否 | Phase 2/5 | 已有脱敏函数，但日志、curl 错误、诊断包、config 展示、n8n execution raw data 脱敏不完全统一。 |
| 路径越权 | P0 | 是 | 否 | Phase 2/4/6 | `safeJoin()`、`isAllowedLocalAssetPath()`、`isOutputPathSafe()` 已有，但分散；部分表单 path 直接 `fs.existsSync()`。 |
| 打包路径写死 | P1 | 是 | 否 | Phase 6 | Mac App Support 已部分接入，但业务代码仍有 macOS 路径、`osascript`、`/usr/bin/open`、`/usr/bin/curl`。 |
| 日志不足 | P1 | 是 | 否 | Phase 2 | 错误多处直接返回页面或吞掉 catch，没有统一 request/error logger。 |
| 诊断包不足 | P1 | 是 | 否 | Phase 5 | 诊断覆盖较多，但导出诊断本身会写文件，也调用状态函数；缺少“只读快照模式”。 |
| n8n 依赖分散 | P1 | 是 | 否 | Phase 7 | DB 查询、webhook resolver、health check、workflow sync 分散在 UI server 和 launcher。 |
| 表单上传解析不稳 | P1 | 是 | 否 | Phase 4 | 手写 multipart parser 用 binary string，图片数量/大小有校验，但 MIME、文件名、边界极端情况风险高。 |
| UI 刷新机制不稳定 | P0 | 是 | 否 | Phase 3 | 页面内多个 poll/reconcile JS 片段重复，active route 更新不是统一机制。 |
| 本地引擎异常恢复不足 | P1 | 是 | 否 | Phase 5/6 | launcher 有 watchdog，但 UI 层恢复建议、n8n DB 锁、端口占用解释还不够产品化。 |
| Mac 命令写死影响 Windows | P2 | 否，当前 Mac 仍可交付 | 否 | Phase 6/10 | `osascript`、`open`、`ioreg`、`sw_vers`、`Library/Application Support` 都需要 PlatformService 收口。 |

## 4. 关键架构发现

1. `serve-review-assets.mjs` 不是一个单纯的 server 文件。它同时是 route、service、repository、template、frontend JS、diagnostics、platform adapter、prompt center、license manager。

2. 状态查询不是纯只读。比如 `collectEnvStatus()` 会在发现状态偏差时写 `project_state`，并且在某些条件下自动 export。人话说：用户只是打开系统页，也可能改变项目状态。

3. 模块加载本身会写目录。文件顶部有多个 `fs.mkdirSync(...)`，结尾还会 `ensureDefaultOutputDirs()`。这意味着以后如果测试直接 import 主文件，会污染运行目录。

4. n8n 读写耦合太多。UI server 直接查 SQLite、拼 webhook、调用 n8n webhook；launcher 又负责启动、同步 workflow、传 env。这些能力应该收进 `n8nService / WorkflowAdapter`。

5. 当前风险最大的重构不是拆模板，而是统一“项目当前阶段”和“用户下一步应该去哪里”。

## 5. 是否建议进入下一阶段

建议进入 Phase 2，但只能进入“测试与日志地基”的最小版本，不建议马上改业务流程。

推荐第一个任务：

新增 `app-server/shared/redact.js` 或同等位置的脱敏工具，并加非付费单测；只新增工具和测试，不迁移主业务调用。

理由：

- 风险最低。
- 不触发模型、不触发 n8n、不改业务流程。
- 能立刻为后续 logger、diagnostics、n8n execution 摘要打地基。
- 回滚只需删除新增工具和测试文件。

