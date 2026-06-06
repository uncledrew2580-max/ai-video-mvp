# P1 工作流阶段重设计需求文档

生成时间：2026-05-11（代码实测审计版）  
作者：Claude Code  
状态：等待 Codex review → 老板确认 → 开始改造

---

> 本文档基于实际代码审计（serve-review-assets.mjs、n8n01/02/03/04.json、prompt_center.json、
> creative_task_type_mapping.json）生成，不是纯文字设计稿。所有"当前状态"描述均对应真实代码行为。

---

## 一、当前系统实际运行架构（代码实测）

```
n8n Form（WF01 formTrigger）
  字段：product_name / product_selling_points / target_market / target_language /
        creative_task_type（7选项）/ product_images / reference_video_url
  ↓
WF01 Director 层
  导演请求体组装 → Gemini → 创意方向提取 → 保存创意方向上下文（concept-context JSON）
  → 重定向 8787/submitted
  ↓
8787 /concepts/item（创意方向审核页，已有左/右双栏 + 可调字段 + 反馈框）
  ↓ POST /concept-select-with-edit
WF02（脚本框架 + 分镜，一条链路不可拆）
  concept_select_normalize → concept_select_restore
  → 脚本请求体组装 → Gemini 脚本框架 → 提取脚本框架JSON
  → 分镜图提示词生成 → NanoBanana → 六宫格裁切
  → 分镜确认打包（review-context JSON）
  ↓
8787 /reviews/item（分镜审核页，当前以 Veo prompt 为主展示）
  ↓ POST /review-submit
WF03（Veo 逐镜视频生成）
  → Veo 提交 → 轮询 → 下载 → 进度写入
  ↓
8787 /review-status（进度 + 最终成片下载）
```

8787 全部路由（实测）：
- `GET /` 工作台首页  
- `GET /submitted` 提交后跳转页  
- `GET /active` 当前项目进度  
- `GET /concepts` 创意方向列表  
- `GET /concepts/item` 创意方向审核页（已有左/右双栏）  
- `GET /concept-status` 创意方向生成进度  
- `POST /concept-select` 选择创意方向  
- `POST /concept-revision-save` 保存结构化修改  
- `POST /concept-select-with-edit` 保存修改 + 触发 WF02  
- `POST /concept-feedback` 重跑创意方向（Codex 临时 patch，直接调 Gemini，待切 WF04）  
- `GET /reviews` 分镜审核列表  
- `GET /reviews/item` 分镜审核详情页  
- `GET /review-status` 视频生成进度 + 成片下载  
- `POST /review-submit` 触发 WF03  
- `POST /review-rerun-failed` / `/review-rerun-pending` / `/review-pause-project`  
- `GET /config` / `POST /config-save`  
- `GET /prompt-center` / `POST /prompt-center-save` / `GET /prompt-center-reset`  

---

## 二、当前系统 vs 1.0 骨架差距（逐阶段）

### Stage 1：Form 表单

| 状态 | 说明 |
|------|------|
| ✅ 已有 | product_name, product_selling_points, target_market, target_language, creative_task_type（7 选项），product_images，reference_video_url |
| ❌ 缺失 | `creative_mode`（explore / fixed_framework） |
| ❌ 缺失 | 高级创意约束字段：target_user, usage_scene, content_style, visual_hook, video_type, grid_count_preference, risk_notes, selling_point_angle |

**影响**：WF01 `On form submission` 节点（n8n01.json formTrigger 参数）。

---

### Stage 2：生成创意方向

| 状态 | 说明 |
|------|------|
| ✅ 已有 | WF01 导演层工作正常，`导演请求体组装` 已注入 hardConstraintBlock（creative_task_type + typeRules）|
| ✅ 已修 | `创意方向提取` 节点 video_type 优先级已修正（typeRules > Gemini 返回值）|
| ❌ 缺失 | explore / fixed_framework 模式分支处理 |
| ❌ 缺失 | fixed_framework 模式下高级约束字段（target_user 等）注入 hardConstraintBlock |
| ❌ 缺失 | explore 输出 2-3 个方向；fixed_framework 输出 1-2 个并降低发散 |

**影响节点**：`导演请求体组装`（注入逻辑）+ prompt_center.json director.generation_config（temperature 参数）。

---

### Stage 3：审核创意方向

| 状态 | 说明 |
|------|------|
| ✅ 已有 | 左（模型生成值）/ 右（可调变量表单）双栏布局 |
| ✅ 已有 | 可调字段：target_user, usage_scene, visual_expression, hook_strategy, video_type, core_selling_angle, why_it_fits_tiktok, recommended_grid, risk_notes |
| ✅ 已有 | 自由反馈文本框（POST /concept-feedback）|
| ⚠️ 问题 | video_type 显示原始枚举（`local_voiceover` 等），未翻译成人话 |
| ⚠️ 问题 | "按修改重新生成" 按钮与 "选择此方向" 在同一表单 edit-actions 区，层级不清 |
| ⚠️ 问题 | `/concept-feedback` 直接调 Gemini（Codex 临时 patch），应改为调 WF04 webhook |
| ❌ 缺失 | 结构化变量修改和反馈同时传入重跑 |

**影响文件**：serve-review-assets.mjs（`renderConceptDetailPage` + `/concept-feedback` handler）。

---

### Stage 4：生成脚本框架（⚠️ 当前黑盒，无法单独审核）

| 状态 | 说明 |
|------|------|
| ✅ 已有 | WF02 可生成脚本框架，`提取脚本框架JSON` 节点输出 script_overview + shots[] |
| ⚠️ 问题 | 脚本框架 + NanoBanana + 裁切在同一链路（WF02），用户无法在脚本生成后暂停审核 |
| ⚠️ 问题 | shots[] 字段由 Gemini 自由生成，无强制 schema（缺 scene_purpose, product_appearance, voiceover_or_subtitle 等） |
| ❌ 缺失 | 脚本框架独立存储（script-context JSON） |
| ❌ 缺失 | 脚本框架写入后跳转到脚本审核页 |

**核心改造**：WF02 拆为 WF02a（到脚本框架）+ WF02b（从 script-context 到分镜）。

---

### Stage 5：审核脚本框架（❌ 当前完全缺失）

| 状态 | 说明 |
|------|------|
| ❌ 缺失 | 无此页面，脚本框架不可审核 |
| ❌ 缺失 | 脚本框架重跑 webhook（WF05） |
| ❌ 缺失 | per-shot 结构化表格展示 |
| ❌ 缺失 | 用户修改每镜字段后确认继续 |

**新增**：`/script-review` 页面 + WF05 webhook。

---

### Stage 6：生成分镜图

| 状态 | 说明 |
|------|------|
| ✅ 已有 | NanoBanana + 六宫格裁切工作正常 |
| ⚠️ 硬锁定 | shots 数量强制 = 6（`Code in JavaScript1/2` 有校验抛错），`grid_count_preference=9` 不可用 |

**1.0 改造**：WF02b 保持现有逻辑不重写。grid_count_preference=9 分支标记 TODO，列入 Milestone 5。

---

### Stage 7：审核分镜图（⚠️ 当前 UI 主次颠倒）

| 状态 | 说明 |
|------|------|
| ✅ 已有 | `/reviews/item` 页面展示每张分镜图 + shot 信息 |
| ⚠️ 问题 | `renderShotScriptAndPromptCards` 以 Veo prompt（`video_prompt`）为主内容展示，用户先读长 prompt 再判断图像是否贴合 |
| ⚠️ 问题 | 脚本框架字段（scene_purpose, action, emotion 等）不在主展示区 |
| ⚠️ 问题 | 黑边/白边问题（独立于骨架，六宫格裁切 or CSS 问题，需专项排查）|
| ❌ 缺失 | Nano prompt 放折叠区 |

**影响函数**：`renderShotScriptAndPromptCards`（serve-review-assets.mjs:1337）。

---

### Stage 8：生成 Veo 视频

| 状态 | 说明 |
|------|------|
| ✅ 完整 | WF03 逐镜串行 + 轮询 + 下载，已验收（proj_1778357441002，6/6，0 音频）|
| ⚠️ 微改 | review-context 需增加 `script_context_path` 字段，供 Stage 9 读取脚本框架 |

---

### Stage 9：审核单镜头视频（❌ 当前缺失）

| 状态 | 说明 |
|------|------|
| ❌ 缺失 | 无逐镜视频查看页面 |
| ❌ 缺失 | 单镜头重做入口（WF03 有 rerun-failed/pending，但无对应 UI 详情页）|

**新增**：`/shot-review` 页面（首帧图 + 视频 + Veo prompt + 脚本摘要 + 重做入口）。

---

### Stage 10：最终视频详情（⚠️ 当前较简陋）

| 状态 | 说明 |
|------|------|
| ✅ 已有 | `/review-status`：6/6 进度 + 成片下载链接 |
| ❌ 缺失 | 使用的创意方向、变量、脚本框架、prompt 版本 |
| ❌ 缺失 | 用户修改记录 |
| ❌ 缺失 | "保存为默认打法" 入口 |

---

## 三、Form 两种模式落地方案

**不做两套 workflow，用 `creative_mode` 字段切换行为。**

### 新增 Form 字段

```
creative_mode       dropdown: explore（默认）/ fixed_framework
target_user         textarea（可选）
usage_scene         textarea（可选）
content_style       text（可选）
visual_hook         textarea（可选）
video_type          dropdown 中文选项（可选）
grid_count_preference  dropdown: 6（默认）/ 9（可选，当前锁定 6）
risk_notes          textarea（可选）
selling_point_angle textarea（可选）
```

### WF01 导演请求体组装改造

`explore` 模式（高级字段为空时）：
- 保持现有逻辑，AI 自由发散 2-3 个方向。
- hardConstraintBlock 只包含 creative_task_type + typeRules。

`fixed_framework` 模式（高级字段有值时）：
- 高级字段全部注入 hardConstraintBlock：
  ```
  - target_user 目标用户约束：...
  - usage_scene 使用场景约束：...
  - content_style 内容风格约束：...
  - visual_hook 视觉 Hook 约束：...
  - video_type 视频类型约束：...
  - selling_point_angle 卖点切入约束：...
  - risk_notes 风险提示：...
  - 输出方向数量：1-2 个（紧贴约束，减少发散）
  ```
- generation_config 中考虑降低 temperature（当前未显式配置）。

---

## 四、n8n Workflow 影响汇总

| Workflow | 文件 | 1.0 影响 | 动作 |
|----------|------|----------|------|
| WF01 | n8n01.json | Form 增字段；explore/fixed_framework 分支 | 修改 |
| WF02a | n8n02.json（拆分） | 只跑到脚本框架，写 script-context | 拆分 |
| WF02b | n8n02.json（拆分） | 从 script-context 读取后继续分镜 | 拆分 |
| WF03 | n8n03.json | 增加 script_context_path；shot-level 结果字段 | 小改 |
| WF04 | n8n04.json | director rerun（已就绪），接入 8787 | 接入 |
| WF05（新） | n8n05.json | 脚本框架重跑 webhook | 新建 |

### WF02 拆分方案（最核心改造）

```
WF02a（保留现有 webhook path：storyboard-concept-select-v1）
  concept_select_normalize
  → concept_select_restore
  → 脚本请求体组装
  → 脚本框架生成（Gemini HTTP Request）
  → 提取脚本框架JSON（增强 shot schema 校验补全）
  → 保存 script-context JSON（新节点）
  → Respond to Webhook（204）
  → 8787 跳转 /script-review

WF02b（新 webhook：storyboard-continue-v1）
  读取 script-context（新节点）
  → 用户修改覆盖 shots（若有 user_edits）
  → 拆分shots数组 → Merge3_6grid
  → 分镜图提示词生成 → NanoBanana → 六宫格裁切
  → 分镜确认打包（写 review-context，增加 script_context_path）
  → Respond to Webhook（204）
  → 8787 跳转 /reviews/item

WF05（新 webhook：script-rerun-v1）
  读取 concept_context_path + feedback + user_edits
  → 加载提示词配置
  → 脚本请求体组装（注入反馈）
  → Gemini 脚本框架
  → 提取脚本框架JSON
  → 保存 script-context JSON（覆盖）
  → Respond to Webhook（200 + summary）
```

---

## 五、新增存储结构

### 新文件类型：script-context JSON

路径：`.n8n-local-cache/script-context/script_context_{project_id}_{round}_{ts}.json`

```json
{
  "project_id": "...",
  "concept_context_path": "...",
  "selected_concept_id": "...",
  "selected_concept_name": "...",
  "script_overview": {
    "script_goal": "...",
    "visual_style": "...",
    "hook_strategy": "...",
    "total_shots": 6
  },
  "shots": [
    {
      "shot_id": "shot_01",
      "shot_order": 1,
      "duration": "3s",
      "scene_purpose": "...",
      "visual_scene": "...",
      "action": "...",
      "product_appearance": "...",
      "selling_point": "...",
      "emotion": "...",
      "camera_movement": "...",
      "voiceover_or_subtitle": "...",
      "transition_note": "...",
      "risk_note": "..."
    }
  ],
  "rerun_count": 0,
  "status": "waiting_for_script_confirmation",
  "created_at": "...",
  "updated_at": "..."
}
```

### concept-context JSON 新增字段

```
creative_mode, target_user, usage_scene, content_style, visual_hook,
video_type_preference, grid_count_preference, risk_notes_input,
selling_point_angle, rerun_count, script_context_path
```

### review-context JSON 新增字段

```
script_context_path   （供视频审核页读取脚本框架）
```

---

## 六、新增页面规范

### /script-review（Stage 5，新增）

布局：
```
[顶部] 项目名 | 产品 | 选定创意方向 | creative_mode
[主体] 每镜头一行结构化表格：
  shot | 时长 | 场景目的 | 画面 | 动作 | 情绪 | 卖点 | 产品出现 | 口播/字幕 | 风险
  （表格内可编辑，或通过整段反馈文本框提修改意见）
[底部]
  [确认脚本框架，继续生成分镜]  → POST /script-confirm → 触发 WF02b
  [按修改重新生成脚本框架]       → POST /script-rerun  → 触发 WF05
```

### 分镜图审核页改造（Stage 7，修改 /reviews/item）

每张分镜卡片改为：
```
[首帧裁切图（全幅）]
镜头 N | 时长：Xs | 场景目的：...
画面：... 动作：... 情绪：... 产品出现：...
口播/字幕：... 镜头目的：...
[▶ Nano prompt（折叠）]
```
Veo prompt 不在此处展示（属于视频审核阶段）。

### /shot-review（Stage 9，新增）

```
[场景首帧图]   [单镜头视频（mp4）]
───────────────────────────────────
镜头 N | 时长 | 场景目的
Veo prompt 原文 + 中文意图注释
对应脚本字段摘要：画面 / 动作 / 情绪 / 卖点
───────────────────────────────────
[单镜头重做]  填写修改意见 → POST /shot-rerun
[通过此镜头]
```

---

## 七、P0 bug vs P1 骨架优先级

### P0（已修复）

| 问题 | 状态 |
|------|------|
| creative_task_type 漂移（video_type 优先级反） | ✅ n8n01 已修复 |
| director rerun webhook | ✅ WF04 已就绪 |
| /concept-feedback 直接调 Gemini | ⚠️ Codex 临时 patch，待 M1 接入 WF04 |

### P1 骨架（分 Milestone）

| 优先级 | 项目 | 工作量 |
|--------|------|--------|
| P1-A（M1，当天） | 8787 /concept-feedback 改调 WF04 webhook | 小 |
| P1-A（M1，当天） | video_type 枚举 → 人话翻译（UI） | 小 |
| P1-A（M1，当天） | "重新生成"按钮移到最下方 | 小 |
| P1-A（M1，当天） | n8n01 + n8n04 DB sync | Codex 执行 |
| P1-B（M2，1-2天） | Form 增 creative_mode + 高级字段 | 小 |
| P1-B（M2，1-2天） | WF01 处理两种模式分支 | 中 |
| P1-C（M3，3-5天） | WF02 拆分 WF02a / WF02b | 大 |
| P1-C（M3，3-5天） | WF05 脚本框架重跑 webhook | 中 |
| P1-C（M3，3-5天） | 8787 /script-review 页面 | 大 |
| P1-C（M3，3-5天） | 分镜图审核页改为脚本字段主展示 | 中 |
| P1-D（M4，2-3天） | 8787 /shot-review 页面 | 中 |
| P1-D（M4，2-3天） | 最终视频详情页增加 prompt 历史/修改记录 | 中 |
| P1-E（M5，后续） | grid_count_preference=9 | 大 |
| P1-E（M5，后续） | 保存为默认打法 + 全自动模式 | 大 |

---

## 八、边界与风险

| 风险 | 描述 |
|------|------|
| WF02 拆分影响现有 concept-select 路径 | 8787 /concept-select-with-edit 当前触发完整 WF02；拆分后变两步，需同步改 8787 端 |
| script-context 与 concept-context 联动 | 脚本重跑要读 selected_concept；路径引用必须正确 |
| NanoBanana shots=6 硬锁 | Code in JavaScript1/2 有 `throw new Error` 校验；grid_count_preference=9 需解锁此处 |
| 黑边/白边问题 | 独立于骨架，需专项排查六宫格裁切尺寸 + CSS 展示逻辑 |
| WF04 未 sync 到 DB | n8n04.json 已就绪，但未在 sync 脚本白名单，需 Codex 手动处理 |

---

## 九、不在本文档范围

- SaaS / 登录 / 多用户 / 计费  
- 三条 workflow 强行合并  
- grid_count_preference=9 完整实现（Milestone 5）  
- 生产环境部署  
- 多语言 TTS / 音频（已移除，不回退）  

---

## 十、代码审计 Review 结论（2026-05-11）

> 审计基准：n8n01.json / n8n02.json / n8n03.json / n8n04.json 实际节点代码，以下 4 项对应 Codex 指定 review 检查点。

---

### 10.1 creative_mode 两种模式能否在现有 WF01/WF02/WF03 落地

**结论：WF01 需改动 2 处，WF02/WF03 无需改动。**

| Workflow | 影响 | 需要改动 |
|----------|------|---------|
| WF01 | `explore` / `fixed_framework` 控制导演提示词约束强度 | ✅ 需改 |
| WF02 | 无感知 mode，只处理已选 concept | ❌ 无需改 |
| WF03 | 无感知 mode，只处理 review-context | ❌ 无需改 |

**WF01 落地方案（最小改动）：**

1. **Form 新增字段**：`creative_mode` 下拉（`explore` / `fixed_framework`，默认 `explore`）
2. **`导演请求体组装` 节点扩展**：已有 `hardConstraintBlock`（注入 creative_task_type + typeRules）。在此块后追加：
   ```
   if creative_mode === 'fixed_framework':
     system prompt 追加"严格遵循以下框架，不允许在框架外创意发挥"
   else (explore):
     system prompt 追加"以下框架仅供参考，允许在约束内自由创意"
   ```
3. **`创意方向提取` 节点无需改动**：已有 typeRules 优先级 fix（P0 已修）

**风险**：Form 字段增加会改变 `concept_context_path` 写入的 `concept-context.json` 结构 → 需要在 `创意方向提取` 节点的输出中明确带出 `creative_mode`，并写入 concept-context.json。否则 WF04 重跑时 mode 信息丢失。

---

### 10.2 各阶段边界是否清晰

**结论：Stage 1→2→3→4 边界基本清晰，但 WF02 内部拆分点存在数据断层风险。**

#### 已验证清晰边界

| 边界点 | 边界文件 | 生产节点 | 消费节点/服务 |
|--------|---------|---------|-------------|
| Stage 1→2 | `concept-context/concept_context_{id}.json` | WF01 `创意方向提取` | WF02 `concept_select_restore`、8787 `/concepts` |
| Stage 2→3 | `selected-concepts/selected_concept_{id}.json` + `project-state/project_{id}.json` | WF02 `concept_select_restore` | WF02 下游、8787 `/reviews` |
| Stage 3→4 | `review-context/review_context_{id}_{round}_{ts}.json` | WF02 `分镜确认打包` | WF03、8787 `/reviews/context` |
| Stage 4 完成 | `n8n视频/{id}/` 目录 | WF03 `视频保存` | 8787 `/reviews/item` |

#### WF02 拆分（WF02a/WF02b）边界风险 ⚠️

当前 WF02 Merge2 是 `combineByPosition` 模式，两路输入：
- 路径 A：`Prompt Library` → `Edit Fields3` → `Code in JavaScript` → Merge2
- 路径 B：`Prompt Library` → Merge2（直接）

**拆分后 WF02a（脚本层）必须保留 Merge2 的双路结构**，否则 `脚本请求体组装` 的 prompt + selected_concept 合并逻辑断裂。

**关键数据断层**：`提取脚本框架JSON` 输出字段中**不包含** `concept_context_path`、`image_1_path`、`image_2_path`。WF02b（分镜层）所需的这三个字段当前通过以下方式绕过：
- `image_1_path` / `image_2_path`：由 `Nano前_轻量上下文` 节点从 Merge2 输出（`concept_select_restore` → Merge2 → `Nano前_轻量上下文`）重新提取，并行于脚本链，在 Merge3_6grid1 汇合
- `concept_context_path`：`分镜确认打包` 节点读取 `first.concept_context_path || ''`，**但 Merge3_6grid1 的任何上游节点均不输出此字段** → **当前值永远为空字符串**

**结论**：`concept_context_path` 在 review-context.json 中写入的始终是空字符串。这是现有代码中的一个隐性 bug，在 WF04 重跑需要读取原始 concept-context 时会暴露（WF04 通过 `concept_context_path` 定位文件）。

---

### 10.3 状态字段、存储结构、节点清单完整性

#### Shot 字段 Schema 不匹配 ⚠️（P0 级改造风险）

1.0 文档第四章提议的 shot schema（`scene_purpose`, `visual_scene`, `action`, `product_appearance`, `selling_point`, `emotion`, `voiceover_or_subtitle`, `transition_note`, `risk_note`）与当前 WF02 `拆分shots数组` 实际输出字段**完全不同**：

| 维度 | 当前字段（代码实际） | 1.0 文档提议字段 |
|------|------------|----------------|
| 场景描述 | `scene_setting` | `visual_scene` |
| 视觉动作 | `visual_action` | `action` |
| 产品状态 | `product_state` | `product_appearance` |
| 情感 | `expression_focus` | `emotion` |
| 旁白 | `optional_voiceover_local` | `voiceover_or_subtitle` |
| 连贯性 | `continuity_requirements` | `transition_note` |
| 无 | — | `scene_purpose`, `selling_point`, `risk_note` |
| 镜头阶段 | `stage` | （未提议） |
| 镜头时长 | `duration` | （未提议） |
| 摄像运动 | `camera_movement` | （未提议） |

**Schema 变更影响链**：
1. Gemini 脚本生成 prompt（`storyboard.user_template` in prompt_center.json）— 需同步更新输出格式
2. `拆分shots数组` 节点 — 需映射新字段
3. `分镜确认打包` 节点 — 读取 `panel.video_prompt`（当前已有）和 shot meta，字段名变更需跟进
4. 8787 `renderShotScriptAndPromptCards`（line 1337）— 展示逻辑引用字段名

**建议**：在 M2 启动 shot schema 变更前，先在 prompt_center.json 的 `storyboard.user_template` 中对齐新字段，然后更新 `拆分shots数组`，最后同步 8787 展示层。不建议在 M1 同时改动。

#### review-context.json 缺失字段

当前 `分镜确认打包` 写入 review-context 的字段：
```
project_id, product_name, target_market, target_language, creative_task_type,
selected_concept_id, selected_concept_name, concept_context_path（永远空）,
panel_count, review_round, panel_review_pack[]
```

1.0 文档提议新增字段：`creative_mode`, `script_context_path`, `storyboard_grid_path`

- `creative_mode`：需从 WF01 → concept-context → WF02 `concept_select_restore` 透传
- `script_context_path`：WF02a 写出 script-context 后，WF02b 入参中带入，`分镜确认打包` 写出
- `storyboard_grid_path`：`NanoBanana结果落盘` 写出路径后，下游 `六宫格裁切_9x16` → `分镜确认打包` 传递

#### 节点清单缺口（M1 必须新增）

| 需新增节点 | 所属 Workflow | 作用 |
|-----------|-------------|------|
| concept-context.json 透传 `creative_mode` | WF01 `创意方向提取` | 写出时带上 creative_mode 字段 |
| script-context.json 写出节点 | WF02a 末尾 | 新文件，记录脚本层结果 + 路径 |
| `concept_context_path` 修复 | WF02 `concept_select_restore` 或 Merge2 | 把路径写入 json 供下游使用 |
| 8787 `/concept-feedback` 改调 WF04 | serve-review-assets.mjs line ~3258 | M1 milestone，替换当前 Codex 直接 Gemini patch |

---

### 10.4 遗漏 P0 风险 / 破坏现有链路的改造点

| 编号 | 风险 | 严重度 | 影响链路 | 建议处理时机 |
|------|------|--------|---------|------------|
| R1 | `concept_context_path` 在 review-context 永远写空 | P0 | WF04 重跑读不到原始 concept-context，feedback 循环断裂 | M1 修复 |
| R2 | Shot schema 不匹配（现有字段 vs 1.0 提议字段） | P0 | schema 不一致时 prompt + split + 展示三处同时错误 | M2 统一变更，M1 不动 |
| R3 | WF02 Merge2 `combineByPosition` 双路依赖 | P1 | WF02a 拆分时若丢失一路输入，脚本请求体组装断裂 | WF02a 拆分时必须保留双路 |
| R4 | Code in JavaScript1/2 shots=6 硬锁（`throw`） | P1 | 变更 shot 数量（如 9_grid）时两处节点同时需改 | M5 解锁 |
| R5 | `creative_mode` 未写入 concept-context.json | P1 | WF04 重跑、WF02 恢复场景读不到 mode，导演约束丢失 | M1 写入 |
| R6 | 8787 `/concept-feedback` 直接调 Gemini（绕过 WF04）| P1 | Codex 当前补丁，未走 n8n 工作流，日志/重试/状态不一致 | M1 切换到 WF04 |
| R7 | n8n04.json 未在 sync 脚本白名单 | P1 | WF04 无法通过标准流程同步到 DB | M1 前 Codex 处理 |
| R8 | `Nano前_轻量上下文` 图片路径依赖 concept_select_restore 透传 | P2 | WF02a 拆分后 WF02b 需要独立重建图片路径来源 | WF02b 设计时处理 |

---

### 10.5 审计总结

**可以直接推进（M1）的改动**（不破坏现有链路）：
- WF01 Form + `导演请求体组装` 追加 `creative_mode` 字段并写入 concept-context
- WF02 `concept_select_restore` 输出中补充 `concept_context_path` 字段（fix R1）
- 8787 `/concept-feedback` 改调 WF04（fix R6）
- WF04 加入 sync 脚本白名单（fix R7）

**需要统一规划后才能动（M2）的改动**：
- Shot schema 变更（R2）— 必须同时改 prompt_center.json + `拆分shots数组` + 8787 展示层
- WF02a/WF02b 拆分（R3）— 需完整测试 Merge2 双路和 Merge3_6grid1 汇合逻辑

**M1 不需要动（M5 才动）的改动**：
- shots=6 硬锁（R4）

---
