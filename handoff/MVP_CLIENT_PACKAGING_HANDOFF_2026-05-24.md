# AI Video MVP 客户端封装交接

更新时间：2026-05-24  
项目路径：`/Users/drew/Downloads/tiktok-n8n-workflow-pack`

## 当前目标

这是一个基于 n8n 的 TikTok 电商 AI 短视频自动化系统，最终交付形式是桌面客户端 **AI Video**。  
当前阶段已经从“修流程”进入“封装 MVP 客户端”阶段。

第一版商业目标：

- 用户只使用客户端，不接触 n8n。
- 用户只需要填写自己的 Kie API Key。
- 模型和工程协议默认锁死，稳定优先。
- 先封装 Mac，跑通后再做 Windows。

## 固定链路

`填表 -> 创意方向 -> 选择方向 -> 脚本框架 -> 分镜图 -> 分镜裁切首帧 -> 图生视频 -> 最终成片`

## 角色分工

- 用户：老板，从业务和普通用户视角测试。
- Claude Code：工程执行者，负责改代码、改 n8n workflow、同步客户端。
- Codex：产品经理/监理/审计，负责拆需求、安排 Claude、审计变更、白话解释给用户。

## 当前稳定配置

普通用户不再看到模型切换。

- Base URL：`https://api.kie.ai/api`
- 文本模型：`gemini-3.1-pro`
- 图片模型：`nano-banana-pro`，4K，六宫格分镜图优先
- 视频模型：`veo3_lite`
- 客户端端口：`18788`
- n8n 端口：`5678`
- 源开发服务历史端口：`8788`，正式客户端不能依赖它

## 当前已完成

1. 客户端主链路已经跑通到视频阶段，用户测试反馈整体可用。
2. 系统配置页朝“只填 Kie API Key”方向收敛。
3. 模型选择在第一版中应隐藏，避免普通用户切换导致接口格式不稳定。
4. 提示词中心普通 UI 已隐藏：
   - 普通页面不再展示“提示词中心 / 自定义提示词 / 在提示词中心编辑”入口。
   - 底层 `/prompt-center` 还存在，建议正式版改成仅开发模式可访问。
5. 创作类型已拆成：
   - `真实故事剧情`
   - `爆点故事剧情`
6. 视频提示词策略已改成稳定优先：
   - 产品一致性优先
   - 单镜头只保留一个主要动作
   - minimal motion
   - subtle hand movement
   - no fast gestures
   - no finger manipulation
   - no fabric warping
   - keep product shape/material/color stable
   - keep face and hands anatomically stable
   - preserve the provided first frame
7. 暂停视频生成已优化：
   - 暂停不再当作失败。
   - 已提交的视频任务仍会自然完成。
8. 单镜头重做已加防重复扣费保护：
   - 前端点击后按钮变成“已提交，生成中…”
   - 后端对同一镜头加本地锁
   - 生成中重复提交会被拦截
9. source / dist / n8n DB 已同步过。

## 最近一次封装前体检结果

检查时间：2026-05-24 凌晨

通过项：

- `http://127.0.0.1:18788/health/meta` 正常。
- 当前运行模式为 `dist`。
- 普通页面 `/`、`/new-project`、`/env` 没有提示词中心入口。
- `/new-project` 已显示 `真实故事剧情` 和 `爆点故事剧情`。
- source / dist 主服务文件一致：
  - `版本测试/serve-review-assets.mjs`
  - `dist/AI Video.app/Contents/Resources/app/版本测试/serve-review-assets.mjs`
  - `dist/AI Video.app/Contents/Resources/app/serve-review-assets.mjs`
- source / dist prompt 文件一致：
  - `prompts/prompt_center.json`
  - `版本测试/prompts/prompt_center.json`
  - dist 对应文件
- n8n workflow 已同步到 DB。

最近 DB workflow 更新时间：

- `rKHHjD2QBlL6EhaM`：`2026-05-23 19:01:18`
- `scriptGenerateV1`：`2026-05-23 19:01:18`
- `storyboardGenerateV1`：`2026-05-23 19:01:18`
- `reviewSubmitVeoV2`：`2026-05-23 19:01:18`

## 关键文件路径

项目根目录：

`/Users/drew/Downloads/tiktok-n8n-workflow-pack`

客户端服务主文件：

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/版本测试/serve-review-assets.mjs`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/dist/AI Video.app/Contents/Resources/app/版本测试/serve-review-assets.mjs`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/dist/AI Video.app/Contents/Resources/app/serve-review-assets.mjs`

提示词配置：

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/prompts/prompt_center.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/版本测试/prompts/prompt_center.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/dist/AI Video.app/Contents/Resources/app/prompts/prompt_center.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/dist/AI Video.app/Contents/Resources/app/版本测试/prompts/prompt_center.json`

创作类型配置：

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/config/creative_task_type_mapping.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/版本测试/config/creative_task_type_mapping.json`

n8n workflow 源文件：

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n01.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n02.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n02a.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n02b.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n03.json`

workflow 同步脚本：

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/sync_iteration_v1_workflows_to_db.mjs`

本地缓存和产物：

- `.n8n-local-cache/`
- 分镜裁切图：`/Users/drew/Downloads/n8n分镜图裁剪`
- 视频产物：`/Users/drew/Downloads/n8n视频`

## 下一步：开始封装客户端

建议顺序：

1. 冻结当前版本，做一个 `MVP-stable` 备份。
2. 先封装 Mac 客户端。
3. 客户端首次启动时自动检查：
   - 本地服务是否启动
   - n8n 是否启动
   - workflow 是否已同步
   - Kie API Key 是否存在
   - 当前有效模型是否为锁定配置
4. 客户端设置页只让普通用户填写 Kie API Key。
5. 正式版隐藏或禁用 `/prompt-center`，建议加开发模式开关：
   - 例如只有 `AI_VIDEO_INTERNAL=1` 时才允许访问。
6. 处理旧进程污染：
   - 客户端启动时检查 `/health/meta`
   - 如果不是当前 app root，杀掉旧服务并重启
   - 确保不依赖 8788
7. Mac 测试通过后，再做 Windows。

## 封装前还建议补的小项

这些不是阻塞项，但建议在正式发给客户前做：

1. `/prompt-center` 直达页加内部模式限制。
2. 系统配置页进一步简化，只展示 Kie API Key 和检测结果。
3. 运行环境页保留“检测/同步工作流”按钮，但文案要普通用户能看懂。
4. 清空测试数据要明确：
   - 清什么
   - 不清什么
   - 不删除 API Key
5. 打包前再做一次“新用户空缓存测试”。

## 2026-05-24 封装推进状态

已完成：

1. 客户端名称统一为 `AI Video`，当前本机服务运行在 `18788`。
2. 默认模型锁定：
   - 文本：`gemini-3.1-pro`
   - 图片：`nano-banana-pro`
   - 视频：`veo3_lite`
   - Base URL：`https://api.kie.ai/api`
3. 普通用户入口已收敛：
   - 首页只保留默认新项目入口，不展示 B 模式。
   - `/prompt-center` 已作为内部维护页隐藏，不作为普通用户入口。
   - 系统配置仍只要求普通用户填 Kie API Key。
4. 运行环境页已加入第一层自修复：
   - `重新同步工作流`
   - `检测运行环境`
   - `清空项目缓存`（保留 API Key）
   - `导出诊断包`
   - `恢复出厂设置`（清空 API Key 和项目缓存，需要两次确认）
5. 诊断包已修复并验证：
   - 导出路径示例：`dist/AI Video.app/Contents/Resources/app/logs/diagnostics/diag-*.json`
   - 已做 API Key 脱敏校验，不泄露当前测试 key。
6. workflow 源文件和本地 n8n DB 已同步：
   - `WF01`、`WF02`、`WF02a`、`WF02b`、`WF03` 均校验通过并写入 DB。
   - 同步后 `execution_entity max(id)` 仍为 `915`，没有触发付费执行。
7. 当前交付候选包：
   - `/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260524/AI Video.app`
   - 已清空 API Key。
   - 已清理 `.n8n-local-cache`、日志和 `project-history.json`。
   - 已扫描确认没有 `nano-banana-2`、`gpt-image-2`、真实 API Key 残留。
   - 包体约 `2.7G`。

当前本机测试入口：

- 开发/自测 app：`/Users/drew/Downloads/tiktok-n8n-workflow-pack/dist/AI Video.app`
- 新用户交付候选包：`/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260524/AI Video.app`

下一步建议：

1. 用候选包做一次“新用户空 key 测试”：打开候选包，进入系统配置，填写 Kie API Key，运行环境检测通过。
2. 只测试到分镜图，确认默认 `gemini-3.1-pro + nano-banana-pro` 稳定。
3. 再选择性测视频，避免无意义消耗积分。
4. 如果 Mac 候选包确认 OK，再做 zip/dmg 分发包；Windows 后置。

## 注意事项

- 不要随便调用 nano-banana 或 Veo，避免烧积分。
- 测试视频阶段前先确认 Kie 余额。
- 第一版不要开放模型切换。
- 第一版不要开放完整提示词中心。
- 提示词可以内部维护，但普通用户只通过表单、创意类型、脚本审核、分镜审核、单镜头重做意见来微调。
- 视频穿模不能彻底消灭，只能靠低动作策略和单镜头重做降低概率。

## 换账号后接续方式

新账号进入后，把这个文件交给新的 Codex/Claude：

`/Users/drew/Downloads/tiktok-n8n-workflow-pack/handoff/MVP_CLIENT_PACKAGING_HANDOFF_2026-05-24.md`

然后让它从“下一步：开始封装客户端”继续，不要重新讨论模型路线。
