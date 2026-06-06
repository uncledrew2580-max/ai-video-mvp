# P8-F Release Gate Handoff — AI-Video-Mac-MVP-20260528-0409

生成时间: 2026-05-28  
工单编号: P8-F-RELEASE-GATE-HANDOFF  
状态: ✅ P8-G 当前机器全链路通过 ⚠️ 完整新 macOS 用户账号测试/DMG 安装测试/新机器验证未完成；release gate 仍未关闭

---

## 1. 当前候选包

| 字段 | 值 |
|------|----|
| 候选包路径 | `release-candidates/AI-Video-Mac-MVP-20260528-0409/AI Video.app` |
| codesign verify | ✅ PASS（`--verify --deep`）|
| app_mode | dist |
| ui_port | 18788 |
| 基于 | `AI-Video-Mac-MVP-20260527-2333`（P8-C 验证通过版本）|

---

## 2. P8-D / P8-D-CLEAN 完成记录

| 项目 | 状态 |
|------|------|
| 旧备份 `n8n02b.json.bak-20260526-175938` 删除 | ✅ |
| RC 非运行 docs（`tiktok_ai_video_workflow_usage.md`、`CLIENT_PACKAGING_PLAN.md`）删除 | ✅ |
| codesign `--force --deep --sign -` + verify | ✅ |
| node_modules build metadata `/Users/drew` 残留（49 个 `.mk/.gypi/.o.d/Makefile`）| ℹ️ 低风险非运行元数据；零 runtime JS 命中；全包严格 grep 仍会命中，后续可通过干净环境 rebuild 消除 |
| RC bundle config key 全部为空 | ✅ |
| Workflow JSON hash（源 == RC）| ✅ 全部 4 个一致 |

---

## 3. P8-E PREPACKAGE-CHECK 完成记录

### 3.1 启动与端口

| 项目 | 结果 |
|------|------|
| 旧 2333 RC 进程（pid 71451）安全 SIGTERM 停止 | ✅ |
| 0409 候选包已启动（Electron + serve-review-assets + n8n）| ✅ |
| 18788 占用进程 | pid 3738 — `AI-Video-Mac-MVP-20260528-0409` serve-review-assets ✅ |
| 5678 占用进程 | pid 3714 — `AI-Video-Mac-MVP-20260528-0409` n8n ✅ |
| 8788 | 空闲；候选包不依赖 8788 ✅ |
| n8n 监听地址 | `127.0.0.1:5678` 仅本地 ✅ |

### 3.2 健康检查

| 端点 | 结果 | 备注 |
|------|------|------|
| `curl --noproxy '*' http://127.0.0.1:18788/` | HTTP 200 ✅ | 裸 curl 返回 502（本机代理污染，见§6）|
| `curl --noproxy '*' http://127.0.0.1:5678/healthz` | HTTP 200 `{"status":"ok"}` ✅ | 同上 |
| `/health/meta` `app_mode` | `dist` ✅ | |
| `/api/env-status` `n8n.ok / ui.ok / workflows.ok / apiKey.ok` | 全部 `true` ✅ | |

### 3.3 dist 模式路径隔离

| 路径 | 值 | 状态 |
|------|----|------|
| config | `~/Library/Application Support/AI Video/config/local-config.json` | ✅ |
| workflow_data_root | `~/Library/Application Support/AI Video/workflow-data` | ✅ |
| n8n DB | `~/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite` | ✅ |

### 3.4 Key 状态

| 位置 | kie.api_key | modelhub_api_key |
|------|-------------|------------------|
| RC bundle config（两处）| 为空 ✅ | 为空 ✅ |
| App Support config（运行时）| **已配置**（非空，不输出值）| 为空 |

### 3.5 Workflow active / hash

| Workflow ID | 名称 | active |
|-------------|------|--------|
| `rKHHjD2QBlL6EhaM` | WF01 TikTok主流程｜表单→创意方向 | ✅ 1 |
| `scriptGenerateV1` | WF02a TikTok续跑｜创意确认→脚本框架 | ✅ 1 |
| `storyboardGenerateV1` | WF02b TikTok续跑｜脚本确认→分镜图生成 | ✅ 1 |
| `reviewSubmitVeoV2` | WF03 TikTok续跑｜分镜审核→视频生成 | ✅ 1 |

- n8n02b.json MD5: `75716680fd2f059a14c0e83ca42c8013` ✅（源 == RC）
- n8n03.json MD5: `d1d71267740e12bb37335d709b2a7453` ✅（源 == RC）

### 3.6 无新增 execution

- Before: max exec id = **12**，total = 12
- After: max exec id = **12**，total = 12
- **P8-E 期间零新增 execution** ✅

### 3.7 禁止项确认

未提交表单 ✅ / 未触发 WF01-03 ✅ / 未触发 Gemini/Nano Banana/Veo/Kie ✅ / 未改代码 ✅ / 未生成 DMG ✅ / 未上传 GitHub ✅

---

## 4. 已验证完整业务闭环历史（P8-C，不是本轮）

本轮 P8-E **没有重新跑业务链路**，也没有验证旧 final-video context（静态访问返回 404，不作为 P8-E 阻塞项；旧 context 在 App Support 内但 URL 路由与新 RC serve 逻辑不匹配）。

完整业务闭环由 **P8-C exec 12**（项目 proj_1779906391739）验证：

| 项目 | 结果 |
|------|------|
| 完整链路 | WF01 → WF02a → WF02b → WF03 ✅ |
| 生成视频 | 6/6 镜头（kie_veo31_proj_1779906391739_shot_{1-6}_*.mp4，1.1–2.6MB 每个）✅ |
| 合成文件 | `~/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/final-video/final_proj_1779906391739_1779910794577.mp4`（9.5MB）✅ |
| final-video 页面 | HTTP 200，6 badge-done，6 `<video>` 元素，全部 200 ✅ |

后续新用户测试需在 0409 候选包上重新验证完整页面流程。

---

## 5. 已知风险

| 风险 | 级别 | 说明 |
|------|------|------|
| 本机代理污染 | 低（环境问题） | `ALL_PROXY=socks5://127.0.0.1:7892` + `HTTP_PROXY=http://127.0.0.1:7892` 导致裸 `curl` 对 localhost 返回 502；**以后本地诊断命令一律加 `--noproxy '*'`** |
| node_modules build metadata 路径残留 | 低（非运行）| 49 个 `.mk/.gypi/.o.d` 文件含 `/Users/drew`；不影响运行逻辑；严格全包 grep 仍会命中；后续干净环境 rebuild 可消除 |
| D.6 config 页示例文字 | 极低（UI 文本）| `placeholder="~/Downloads/tiktok-videos"` 为配置页输入框提示文字，非运行 fallback；后续可改为 App Support 路径 |
| 旧 final-video 404 | 非阻塞 | 旧 P8-C context 在 App Support 内，但 0409 serve 路由不匹配；后续新用户测试会自然产生新 context |

---

## 6. RELEASE_CHECKLIST 门禁状态

### ✅ Done（已完成）

| # | 项目 |
|---|------|
| 1 | P8-C 完整业务链路验证（WF01→WF02a→WF02b→WF03→6/6 视频→final video）|
| 2 | FIX1–5 全部修复并固化（require('process') / candidates 数组 / App Support 路径）|
| 3 | 候选包 AI-Video-Mac-MVP-20260528-0409 生成 |
| 4 | RC 旧备份 / 非运行 docs 清理 |
| 5 | Workflow JSON hash 源 == RC（全部 4 个）|
| 6 | Config key RC bundle 为空 |
| 7 | 模型冻结：gemini-3.1-pro / nano-banana-pro / veo3_lite |
| 8 | 无旧 flash 模型 / 无 127.0.0.1:6478 / 无 /Users/drew 运行代码 |
| 9 | codesign ad-hoc 通过 |
| 10 | dist 模式 App Support 路径隔离（config / workflow-data / n8n DB）|
| 11 | 18788 UI HTTP 200（--noproxy）|
| 12 | 5678 n8n health HTTP 200（--noproxy）|
| 13 | 8788 空闲 |
| 14 | app_mode=dist 确认 |
| 15 | WF01/WF02a/WF02b/WF03 全部 active=1 |
| 16 | P8-E execution before/after = 12/12，无新增 |
| 17 | check-config-consistency.mjs 25/25 PASS |
| 18 | check-dist-config-single-source.mjs 5/5 PASS |

### ⚠️ Partial（已做但有保留）

| # | 项目 | 缺口 |
|---|------|------|
| 19 | final-video 页面验证 | P8-C 验证基于旧 RC；0409 候选包启动后未重新跑完整链路确认页面 |
| 20 | n8n 非运行告警 | Python runner 不可用、image-edit-tools 未安装——当前链路不依赖，无阻塞 |
| 21 | node_modules build metadata 清洁度 | 49 个文件含 /Users/drew，低风险但全包 grep 会命中 |

### ✅ Done（P8-G 新增完成）

| # | 项目 |
|---|------|
| 22 | ✅ **准新用户本机测试（P8-G）**：0409 候选包，全新项目 proj_1779917577299（LED补光灯），WF01→WF02a→WF02b→WF03→6/6 视频→final video 9.1MB ⚠️ 同机测试；P9 新 macOS 用户账号/新机器验证仍需完成 |
| 23 | ✅ **Final-video 页面验证**：HTTP 200，7 badge-done（6 镜头+1合成），6 `<video>` 元素，全部 HTTP 200 |

### ❌ Pending（必须完成才能交付）

| # | 项目 | 说明 |
|---|------|------|
| 24 | **DMG 打包** | 需用户明确授权后执行（P8-G 已通过）|
| 25 | **GitHub 发布 / 客户交付** | 仅在 DMG 验证后执行 |

### 🚫 Blocked（明确禁止，直到 Pending 完成）

| # | 项目 |
|---|------|
| 26 | DMG 生成 |
| 27 | GitHub 上传 / Release |
| 28 | 客户交付 |

**结论：P8-G 当前机器全链路通过。完整新 macOS 用户账号测试、DMG 安装测试、新机器验证未完成；release gate 仍未关闭。DMG/GitHub/客户交付需用户明确授权，并完成 P9 验证后方可执行。**

---

## 7. 下一步最小工单建议

### 方案 A：P9 新 macOS 用户账号测试（优先，P8-G 已完成本机测试）

在新 macOS 系统账号或新机器上验证：
1. 全新账号（无 `~/Library/Application Support/AI Video/` 数据）
2. 打开 `AI-Video-Mac-MVP-20260528-0409/AI Video.app`
3. 填写 Kie API Key（在系统配置页）
4. 提交一次完整表单，跑 WF01 → WF02a → WF02b → WF03
5. 确认 final-video 页面 6 个视频全部生成
6. 仅在这一步明确授权后才触发 Gemini/Nano Banana/Veo

### 方案 B：DMG 打包预检（仅在用户明确授权后执行）

P9 通过且用户明确授权后，才执行 DMG 工单。工单需单独确认授权。GitHub Release/客户交付仅在 DMG 验证后执行。

---

## 8. 睡醒后验证步骤（无需触发付费模型）

1. 打开 `/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260528-0409/AI Video.app`
2. 等待约 30 秒让 n8n 启动
3. 访问 `http://127.0.0.1:18788/`（正常应显示"AI Video 工作台"）
4. 访问 `http://127.0.0.1:18788/config`（系统配置页，确认 Kie API Key 已填写，模型显示正确）
5. 如需诊断，使用 `curl --noproxy '*' http://127.0.0.1:18788/healthz` 和 `curl --noproxy '*' http://127.0.0.1:5678/healthz`
6. **不要提交表单**，除非明确决定进入 P8-G 新用户测试

---

## 9. 关键文件索引

| 文件 | 用途 |
|------|------|
| `docs/P8-D-handoff-20260528.md` | P8-C 修复记录 + P8-D-CLEAN 清理记录 |
| `docs/P8-F-release-gate-handoff-20260528.md` | 本文件：release gate 门禁状态 |
| `release-candidates/AI-Video-Mac-MVP-20260528-0409/AI Video.app` | 当前待测候选包 |
| `正式导入文件/iteration-v1/n8n03.json` MD5 `d1d71267740e12bb37335d709b2a7453` | WF03 含 FIX4+FIX5 |
| `正式导入文件/iteration-v1/n8n02b.json` MD5 `75716680fd2f059a14c0e83ca42c8013` | WF02b 含 FIX3 |
| `~/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/final-video/final_proj_1779906391739_1779910794577.mp4` | P8-C 业务闭环证据（9.5MB）|
