# P12 候选包生成 + 运行态验证报告 — AI-Video-Mac-MVP-20260528-0849

生成时间: 2026-05-28  
工单编号: P12-RC-GENERATION-RUNTIME-AUDIT  
状态: ⚠️ RC 生成 ✅ / 运行态核心验证 ✅ / **App Support prompt 同步 ❌ 阻塞（需用户授权）**

---

## 1. 候选包信息

| 字段 | 值 |
|------|----|
| 候选包路径 | `release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app` |
| 基于 | `AI-Video-Mac-MVP-20260528-0409`（已含 P11 + P11-REWORK 全部修复）|
| codesign | ✅ PASS（`--force --deep --sign -` + `--verify --deep`）|
| app_mode | dist |
| ui_port | 18788 |
| n8n_port | 5678 |
| 包体积 | 3.0G |

---

## 2. RC 生成步骤

```bash
# 1. 复制
/usr/bin/ditto \
  "release-candidates/AI-Video-Mac-MVP-20260528-0409/AI Video.app" \
  "release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app"

# 2. 重签名
/usr/bin/codesign --force --deep --sign - \
  "release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app"  # ✅ PASS

# 3. 停止旧 0409 RC（pid 27521）
kill -SIGTERM 27521

# 4. 启动新 0849 RC
open -a "release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app" --args --no-browser
```

Workflow JSON MD5（0849 RC bundle，与源文件一致）：

| 文件 | MD5 |
|------|-----|
| n8n01.json | `009beada9e430a158857c2b18c243e09` ✅ |
| n8n02a.json | `03ef239ab5819c155322b92b8896b3c5` ✅ |
| n8n02b.json | `75716680fd2f059a14c0e83ca42c8013` ✅ |
| n8n03.json | `d1d71267740e12bb37335d709b2a7453` ✅ |

---

## 3. 运行态验证

### 3.1 端口与进程

| 端口 | PID | 进程 | 状态 |
|------|-----|------|------|
| 18788 | 90498 | `AI-Video-Mac-MVP-20260528-0849/…/node serve-review-assets.mjs` | ✅ 0849 RC |
| 5678 | 90037, 90488 | n8n | ✅ |
| Electron | 89896 | `AI-Video-Mac-MVP-20260528-0849/…/Electron --no-browser` | ✅ 0849 RC |

旧 0409 RC 进程（pid 27521）已 SIGTERM 停止 ✅

### 3.2 健康检查

| 端点 | 结果 |
|------|------|
| `curl --noproxy '*' http://127.0.0.1:18788/` | HTTP 200 ✅ |
| `curl --noproxy '*' http://127.0.0.1:5678/healthz` | `{"status":"ok"}` ✅ |

### 3.3 /health/meta

| 字段 | 值 | 状态 |
|------|----|------|
| app_mode | `dist` | ✅ |
| ui_port | 18788 | ✅ |
| project_root | `.../AI-Video-Mac-MVP-20260528-0849/AI Video.app/Contents/Resources/app` | ✅ 0849 |
| workflow_data_root | `~/Library/Application Support/AI Video/workflow-data` | ✅ |
| config_path | `~/Library/Application Support/AI Video/config/local-config.json` | ✅ |
| kie_api_key_configured | true | ✅ |

### 3.4 /api/env-status

| 字段 | 值 | 状态 |
|------|----|------|
| ui.ok | true | ✅ |
| n8n.ok | true | ✅ |
| workflows.ok | true | ✅ |
| apiKey.ok | true | ✅ |
| apiKey.masked | `0187****` | ✅（脱敏）|
| model_text | `gemini-3.1-pro` | ✅ 冻结 |
| model_image | `nano-banana-pro` | ✅ 冻结 |
| model_video | `veo3_lite` | ✅ 冻结 |

### 3.5 /local-file 面板图片验证（P11 Fix 修复确认）

测试路径：`/Users/drew/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/分镜图裁剪/previews/panel_preview_proj_1779906391739_shot_1_1779908370206.jpg`

```
HTTP 200  9306 bytes  ✅
```

- `isAllowedLocalAssetPath` 新增 `CACHE_ROOT/分镜图裁剪` → P11 Fix 1 **生效** ✅
- `panel_preview_path` via `/local-file?path=` 路径渲染 → P11 Fix 2/3/4 **生效** ✅

### 3.6 RC bundle serve-review-assets.mjs P11 修复确认

| Fix | 内容 | 状态 |
|-----|------|------|
| Fix 1 | `isAllowedLocalAssetPath` 新增 `分镜图裁剪` | ✅ 在 bundle（line 806）|
| Fix 2 | `renderShotScriptAndPromptCards` 用 `panel_preview_path` | ✅ |
| Fix 3 | `renderReviewDetailPage` 用 `panel_preview_path` | ✅ |
| Fix 4 | `previews` 数组用 `panel_preview_path` | ✅ |
| Fix 5 | `建议宫格` 固定为只读 `6_grid` | ✅ |
| Fix 6 | 概念详情页 `建议宫格` 固定显示 `6_grid（当前版本固定）` | ✅ |

### 3.7 Execution 计数

| 时间点 | max exec id | total |
|--------|-------------|-------|
| P12 验证前 | 17 | 17 |
| P12 验证后 | 17 | 17 |

**P12 验证期间零新增 execution** ✅

---

## 4. ⚠️ App Support Prompt 策略审计（发现阻塞项）

### 4.1 加载路径

在 dist 模式下，`serve-review-assets.mjs` 的 prompt 加载路径（line 80）：

```js
const PROMPTS_DIR = APP_MODE === 'dist'
  ? path.join(APP_SUPPORT_DIR, 'prompts')  // ← 实际读取路径
  : BUNDLED_PROMPTS_DIR;
```

**运行时实际读取**：`~/Library/Application Support/AI Video/prompts/prompt_center.json`  
**bundle 内置路径**：`[RC bundle]/版本测试/prompts/prompt_center.json`（seed only）

Seed 逻辑（line 747–750）：**仅在 App Support 文件不存在时从 bundle 复制一次**，之后不再更新。

### 4.2 ❌ 阻塞发现：App Support prompt_center.json 未同步 P11-REWORK 修复

| 字段 | App Support 值 | RC Bundle 值 | 状态 |
|------|----------------|--------------|------|
| `_version` | `1.1.0` | `1.1.0` | 版本号相同但内容不同 ⚠️ |
| `director.user_template` | 含 "6 到 9 个镜头" / "6宫格还是9宫格" | 已改为 "6 个镜头（固定）" | **❌ 旧版本**|
| `script.system_instruction` | 含 TikTok 约束 | 含 TikTok 约束 | ≠（细节差异）|
| `script.user_template` | 不同 | 含 item 18/19 | ❌ |
| `storyboard.system_instruction` | 含 TikTok 约束 | 含 TikTok 约束 | ≠（细节差异）|

**影响**：WF01 运行时实际使用的 `director.user_template` 仍包含 9_grid 相关指令，会让 Gemini 生成带有 "建议 9 宫格" 的创意方向。P11-REWORK Item B（`director.user_template` 修复）对运行时**未生效**。

**原因**：P11-REWORK 更新了 4 个源码/bundle 副本，但 App Support 用户数据文件不在 `cp` 同步范围内。

### 4.3 无版本迁移机制

当前无版本检测/迁移逻辑。当 bundle 版本更新后，不会自动覆盖 App Support 现有文件。需要手动同步或增加迁移机制。

### 4.4 修复方案（需用户明确授权）

**方案 A（立即修复，推荐）**：用 bundle copy 覆盖 App Support copy：
```bash
cp "release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app/Contents/Resources/app/版本测试/prompts/prompt_center.json" \
   "/Users/drew/Library/Application Support/AI Video/prompts/prompt_center.json"
```
效果：运行时立即读取正确版本，director.user_template 9_grid 修复生效。覆盖用户在 App Support 中的自定义 prompt（如有）。

**方案 B（后续工单）**：在 `loadPromptCenter()` 添加 `_version` 比对逻辑，当 bundle 版本高于 App Support 版本时自动迁移（或提示用户重置）。

---

## 5. 禁止项确认

| 禁止项 | 状态 |
|--------|------|
| 未修改 workflow JSON | ✅ |
| 未触发 Gemini / Nano Banana / Veo / 任何付费 API | ✅ |
| 未生成 DMG | ✅ |
| 未上传 GitHub | ✅ |
| 未改 Code 节点 / Kie 请求 | ✅ |
| 未清空用户数据 | ✅ |
| 未 kill 非本项目进程 | ✅ |
| 未在 .app 内 npm install | ✅ |

---

## 6. RELEASE_CHECKLIST 更新

### ✅ Done（P12 新增）

| # | 项目 |
|---|------|
| 29 | 0849 RC 生成（ditto from 0409 + codesign PASS）|
| 30 | 0849 RC 启动 + UI 200 + n8n health ok + app_mode=dist + project_root=0849 |
| 31 | /local-file 面板图片 HTTP 200（P11 Fix 1-4 运行态确认）|
| 32 | 模型冻结确认（gemini-3.1-pro / nano-banana-pro / veo3_lite）|
| 33 | P12 验证期间 execution before/after = 17/17，无新增 |

### ❌ Pending（新增阻塞项）

| # | 项目 | 说明 |
|---|------|------|
| 34 | **App Support prompt_center.json 同步** | director.user_template 含旧 9_grid 指令；需用户授权用 bundle copy 覆盖，或 P13 工单添加版本迁移机制 |
| 24 | **DMG 打包** | 仍需用户明确授权后执行 |
| 25 | **GitHub 发布 / 客户交付** | 仅在 DMG 验证后执行 |

---

## 7. 下一步建议

### 立即行动（需用户明确授权）

**覆盖 App Support prompt_center.json**（方案 A）：
```bash
cp "release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app/Contents/Resources/app/版本测试/prompts/prompt_center.json" \
   "/Users/drew/Library/Application Support/AI Video/prompts/prompt_center.json"
```
覆盖后需重新访问 `http://127.0.0.1:18788/config` 验证 prompt 内容正确显示。

### 后续工单

1. **P13（可选）**：`loadPromptCenter()` 添加版本迁移机制，防止后续版本更新时 App Support copy 再次滞后
2. **DMG 打包**：仅在用户授权 + App Support prompt 同步后执行
3. **GitHub Release / 客户交付**：仅在 DMG 验证后执行

---

## 8. 关键文件索引

| 文件 | 用途 |
|------|------|
| `release-candidates/AI-Video-Mac-MVP-20260528-0849/AI Video.app` | P12 当前候选包（已启动）|
| `docs/P12-release-candidate-0849-20260528.md` | 本文件 |
| `~/Library/Application Support/AI Video/prompts/prompt_center.json` | **运行时实际读取** — 需同步 |
| `[0849 bundle]/版本测试/prompts/prompt_center.json` | 正确版本（含所有 P11/P11-REWORK 修复）|
