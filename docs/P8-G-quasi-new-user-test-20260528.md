# P8-G 准新用户测试报告 — AI-Video-Mac-MVP-20260528-0409

生成时间: 2026-05-28  
工单编号: P8-G-QUASI-NEW-USER-TEST  
状态: ✅ 当前机器完整业务链路通过（proj_1779917577299）⚠️ 非新 macOS 用户账号/新机器验证；release gate 仍未关闭

> **Codex Review P8-G-DOCFIX 修正说明**：原文档存在两处问题已修正：(1) 删除 API Key 前缀明文记录；(2) 修正 RELEASE_CHECKLIST 计数及 release gate 表述——P8-G 为同机准新用户测试，不等同于完整新 macOS 用户账号验证，后续仍需 P9 方可关闭 release gate。

---

## 1. 测试目标

在当前机器上模拟准新用户，对 `AI-Video-Mac-MVP-20260528-0409` 候选包执行完整业务闭环测试。  
使用与 P8-C 完全不同的新项目（`proj_1779917577299`，LED补光灯），验证候选包端到端能力。

---

## 2. 候选包信息

| 字段 | 值 |
|------|----|
| 候选包路径 | `release-candidates/AI-Video-Mac-MVP-20260528-0409/AI Video.app` |
| app_mode | dist |
| ui_port | 18788 |
| n8n_port | 5678 |
| RC MD5 n8n01.json | `009beada9e430a158857c2b18c243e09` |
| RC MD5 n8n02a.json | `03ef239ab5819c155322b92b8896b3c5` |
| RC MD5 n8n02b.json | `75716680fd2f059a14c0e83ca42c8013` |
| RC MD5 n8n03.json | `d1d71267740e12bb37335d709b2a7453` |

---

## 3. 隔离策略与发现

### 3.1 执行策略

**策略 B（环境变量）**：直接启动 Electron 二进制，通过三个环境变量覆盖运行时路径：

```
WORKFLOW_DATA_ROOT=/private/tmp/ai-video-p8g-20260528-0526/workflow-data
N8N_USER_FOLDER=/private/tmp/ai-video-p8g-20260528-0526/n8n-user
AI_VIDEO_CONFIG_PATH=/private/tmp/ai-video-p8g-20260528-0526/config/local-config.json
```

### 3.2 隔离有效性发现（重要）

| 组件 | 隔离效果 | 说明 |
|------|---------|------|
| serve-review-assets.mjs（UI） | ✅ 完全隔离 | /health/meta 确认 workflow_data_root = 隔离目录 |
| n8n 数据库 | ✅ 完全隔离 | N8N_USER_FOLDER 有效，DB 位于隔离目录 |
| n8n Code 节点文件写入 | ❌ 未隔离 | task runner sandbox 未继承 WORKFLOW_DATA_ROOT |

**根因**：launcher.mjs 将 `WORKFLOW_DATA_ROOT` 传入 n8n 进程环境，但 n8n 的 task runner（isolated-vm 模式，独立进程）在 Code 节点内调用 `require('process').env.WORKFLOW_DATA_ROOT` 时无法获取该变量，回退到 `os.homedir()` 即真实 App Support 路径。

**影响评估**：对真实新用户无影响。真实新用户的 `~/Library/Application Support/AI Video/` 即为正确的运行时路径。该发现仅影响隔离测试的路径一致性，不影响产品功能。

### 3.3 测试处理方式

发现 WF01 在隔离实例中成功执行（exec 1，独立 n8n DB），但 Code 节点将上下文文件写入了真实 App Support（`proj_1779917577299` 已生成）。

由于 UI 读取隔离目录（空），UI 无法展示该项目。因此：

1. 停止隔离 Electron 实例（SIGTERM pid 23213）
2. 以正常模式（无环境变量覆盖）重新启动 0409 候选包
3. 使用已生成的 `proj_1779917577299`（全新项目，与 P8-C 的 `proj_1779906391739` 无关）继续完整链路测试

---

## 4. 启动验证（P8-G Step C）

### 4.1 进程与端口

| 项目 | 结果 |
|------|------|
| 0409 候选包 Electron 启动 | ✅ |
| 18788 UI 就绪 | ✅ HTTP 200（--noproxy） |
| 5678 n8n 就绪 | ✅ `{"status":"ok"}` |
| app_mode | `dist` ✅ |
| project_root | 0409 RC ✅ |

### 4.2 环境状态

| 字段 | 值 | 状态 |
|------|----|------|
| workflow_data_root | `~/Library/Application Support/AI Video/workflow-data` | ✅ |
| config_path | `~/Library/Application Support/AI Video/config/local-config.json` | ✅ |
| n8n DB | `~/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite` | ✅ |
| ui.ok | true | ✅ |
| n8n.ok | true | ✅ |
| workflows.ok | true | ✅ |
| apiKey.ok | true | ✅ |
| apiKey 状态 | 已配置（脱敏，不记录前缀/值）| ✅ |

### 4.3 模型冻结确认

| 模型类型 | 值 | 状态 |
|---------|-----|------|
| text_model | `gemini-3.1-pro` | ✅ |
| image_model | `nano-banana-pro` | ✅ |
| video_model | `veo3_lite` | ✅ |

### 4.4 Workflow active 状态

| Workflow ID | 名称 | active |
|-------------|------|--------|
| `rKHHjD2QBlL6EhaM` | WF01 TikTok主流程｜表单→创意方向 | ✅ 1 |
| `scriptGenerateV1` | WF02a TikTok续跑｜创意确认→脚本框架 | ✅ 1 |
| `storyboardGenerateV1` | WF02b TikTok续跑｜脚本确认→分镜图生成 | ✅ 1 |
| `reviewSubmitVeoV2` | WF03 TikTok续跑｜分镜审核→视频生成 | ✅ 1 |

### 4.5 Execution Before（隔离 DB）

| 指标 | 值 |
|------|-----|
| 隔离 DB 最大 exec id（WF01 提交前）| null（全新 DB）|
| 隔离 DB execution 总数（WF01 提交前）| 0 |

---

## 5. 完整业务链路测试（P8-G Step D）

### 5.1 测试项目信息

| 字段 | 值 |
|------|----|
| 项目 ID | `proj_1779917577299` |
| 产品名称 | LED补光灯 |
| 目标市场 | United States |
| 目标语言 | English |
| 创作任务类型 | 种草 |
| 选定创意方向 | concept_01（美妆博主的素人爆改神光） |

### 5.2 执行记录

| exec id | workflowId | 状态 | 开始 | 结束 | 说明 |
|---------|-----------|------|------|------|------|
| 1（隔离 DB） | rKHHjD2QBlL6EhaM | ✅ success | 21:32:14 | 21:32:57 | WF01，隔离 Electron 实例 |
| 13 | scriptGenerateV1 | ✅ success | 21:39:10 | 21:39:52 | WF02a，正常实例 |
| 14 | storyboardGenerateV1 | ✅ success | 21:40:28 | 21:42:00 | WF02b |
| 15 | reviewSubmitVeoV2 | ✅ success | 21:42:34 | 21:57:48 | WF03（5/6，shot_6 API error） |
| 16 | reviewSubmitVeoV2 | ✅ success | 21:58:35 | 22:02:15 | WF03 重试 1（5/6，shot_6 再次 API error） |
| 17 | reviewSubmitVeoV2 | ✅ success | 22:02:35 | 22:05:03 | WF03 重试 2（6/6 ✅） |

**Shot_6 说明**：两次出现 `"Internal Error, Please try again later."` 来自 Kie/Veo 服务端。第三次提交成功。属于 Kie API 瞬时错误，非代码缺陷。系统的重试页面（`/review-rerun-failed`）工作正常。

### 5.3 生成视频文件

| 镜头 | 文件名 | 大小 |
|------|--------|------|
| shot_1 | kie_veo31_proj_1779917577299_shot_1_def95f4f5aed9f5a836d8c17.mp4 | 1.2MB |
| shot_2 | kie_veo31_proj_1779917577299_shot_2_f8bd49a34e4b1f06143a1f18.mp4 | 1.3MB |
| shot_3 | kie_veo31_proj_1779917577299_shot_3_2fc35beb8a517845a01f23d1.mp4 | 1.5MB |
| shot_4 | kie_veo31_proj_1779917577299_shot_4_1f5155e3344d3ab720c11238.mp4 | 1.8MB |
| shot_5 | kie_veo31_proj_1779917577299_shot_5_548b08e0e48ec8db29c4eb44.mp4 | 2.0MB |
| shot_6 | kie_veo31_proj_1779917577299_shot_6_5fb07ba324d9ab122034871f.mp4 | 2.2MB |

合成文件: `final_proj_1779917577299_1779919500400.mp4`（9.1MB）✅

---

## 6. Final-Video 页面验证（P8-G Step E）

| 项目 | 结果 |
|------|------|
| `/final-video?context=review_context_proj_1779917577299_1_1779918120503.json` HTTP | 200 ✅ |
| badge-done 数量 | 7（6 镜头 + 1 合成视频）✅ |
| `<video>` 元素数量 | 6 ✅ |
| 6 个 `/local-file?path=...` 视频源 HTTP | 全部 200 ✅ |
| badge-failed 实例 | 0（CSS 类定义不计）✅ |
| badge-loading 实例 | 0 ✅ |

---

## 7. 禁止项确认

| 禁止项 | 状态 |
|--------|------|
| 未提交非授权表单（WF01 提交经 P8-G 授权）| ✅ |
| 未改代码 | ✅ |
| 未生成 DMG | ✅ |
| 未上传 GitHub | ✅ |
| 未改 n8n04.json | ✅ |
| 未删除现有 App Support 数据 | ✅ |
| 模型冻结（Gemini-3.1-pro / Nano-banana-pro / Veo3_lite）| ✅ |

---

## 8. 已知风险与注意事项

| 风险 | 级别 | 说明 |
|------|------|------|
| n8n task runner 不继承 WORKFLOW_DATA_ROOT | 低（非运行阻塞）| Code 节点回退到 os.homedir()；真实新用户路径正确；仅影响完全隔离测试 |
| Kie/Veo shot 生成偶发 Internal Error | 低（API 瞬时）| WF03 第三次重试成功；系统有重试 UI；不阻塞发布 |
| node_modules build metadata /Users/drew 残留 | 低（非运行）| 49 个 .mk/.gypi/.o.d 文件；不影响运行逻辑（见 P8-D handoff §G）|

---

## 9. RELEASE_CHECKLIST 更新状态

### ✅ Done（新增完成）

| # | 项目 |
|---|------|
| 22 | **P8-G 准新用户测试通过**：0409 候选包，全新项目 proj_1779917577299，WF01→WF02a→WF02b→WF03→6/6 视频→final video ✅ |
| 23 | **Final-video 页面验证**：HTTP 200，6 badge-done，6 `<video>`，全部 HTTP 200 ✅ |

### ❌ Pending（剩余）

| # | 项目 | 说明 |
|---|------|------|
| 24 | **DMG 打包** | 需用户明确授权后执行 |
| 25 | **GitHub 发布 / 客户交付** | 仅在 DMG 验证后执行 |

### 🚫 Blocked（明确禁止，直到用户授权 DMG）

| # | 项目 |
|---|------|
| 26 | DMG 生成 |
| 27 | GitHub 上传 / Release |
| 28 | 客户交付 |

**结论：P8-G 当前 Mac 全链路通过。完整新 macOS 用户账号测试、DMG 安装测试、新机器验证未完成；release gate 仍未关闭。DMG/GitHub/客户交付仍需用户明确授权，并完成 P9 验证后方可执行。**

---

## 10. 下一步建议

P8-G 当前机器全链路通过，但 release gate 尚未满足完整交付条件。下一步：

1. **P9（优先）**：在新 macOS 用户账号或新机器上安装 0409 候选包，执行完整 WF01→WF02a→WF02b→WF03 链路，验证真实新用户路径隔离
2. **DMG 打包预检**：仅在用户明确授权后执行，不得提前
3. **GitHub 发布 / 客户交付**：仅在 DMG 验证完成后执行，禁止提前

---

## 11. 关键文件索引

| 文件 | 用途 |
|------|------|
| `docs/P8-F-release-gate-handoff-20260528.md` | Release gate 门禁状态（#22/#23 现已完成）|
| `docs/P8-G-quasi-new-user-test-20260528.md` | 本文件：P8-G 准新用户测试报告 |
| `release-candidates/AI-Video-Mac-MVP-20260528-0409/AI Video.app` | 已验证候选包 |
| `~/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/final-video/final_proj_1779917577299_1779919500400.mp4` | P8-G 业务闭环证据（9.1MB）|
| `/private/tmp/ai-video-p8g-20260528-0526/` | 隔离测试目录（可清理）|
