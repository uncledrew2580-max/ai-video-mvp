# Codex / Claude Code Handoff - 2026-05-26 Script Framework Fix

> This handoff contains no API keys, tokens, Authorization headers, or secrets.

## 1. Project Anchor

- Project root: `/Users/drew/Downloads/tiktok-n8n-workflow-pack`
- Frozen business handoff: `/Users/drew/Downloads/tiktok-n8n-workflow-pack/handoff/MVP_CLIENT_PACKAGING_HANDOFF_2026-05-24.md`
- Current running RC app observed during debugging:
  `/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260526-1901/AI Video.app`
- Current App Support n8n DB:
  `/Users/drew/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite`
- Current test project:
  `proj_1779792205843`

## 2. Frozen Business Rules Still Apply

Do not change the product workflow:

1. Form + product image
2. Creative direction
3. Select direction
4. Script framework
5. Storyboard image
6. Crop first frame
7. Image-to-video
8. Final video

Frozen default models:

- Base URL: `https://api.kie.ai/api`
- Text model: `gemini-3.1-pro`
- Image model: `nano-banana-pro`
- Video model: `veo3_lite`

User-facing rule:

- Normal users only enter their Kie API Key.
- Normal users must not see model switching.
- Normal users must not touch n8n.

## 3. User-Visible Problem

The user reported:

- Creative direction could succeed.
- Script framework stayed on "generating".
- Repeated clicks did not reliably advance.
- The user expected the second model call to work if the first model call worked.

## 4. Actual Root Cause

The first and second stages were not using the same API route.

### Stage 1: WF01 Creative Direction

WF01 used the correct Kie route:

- Adapter: `kie_openai_chat`
- Host: `api.kie.ai`
- Model: `gemini-3.1-pro`

This is why creative direction could succeed.

### Stage 2: WF02a Script Framework

WF02a `scriptGenerateV1` still had old Google-native logic:

- It used `readGeminiKey()`.
- It selected Google native adapter logic.
- It could fall back to `gemini-3-flash-preview`.
- It called `generativelanguage.googleapis.com`.

This caused repeated 315 second HTTP Request timeouts in executions `13`, `14`, `15`, and `16`.

After route was fixed to Kie, a second issue appeared:

- WF02a still sent a Gemini-native `contents` request body.
- Kie OpenAI-compatible chat completions expects `messages`.
- Execution `17` failed quickly with Kie `422 messages is required`.

So the concrete root cause chain was:

1. WF02a had stale Google-native route config.
2. Sync initially targeted the wrong DB.
3. After route fix, WF02a was missing Kie/OpenAI body adaptation.

## 5. Fixes Completed

### 5.1 WF02a Route Fixed

Modified source workflow:

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n02a.json`

Changed node:

- Workflow: `scriptGenerateV1`
- Node: `读取脚本API配置`

Result:

- Removed Google-native route logic.
- Removed `readGeminiKey`.
- Removed `isGoogleModel`.
- Removed `gemini-3-flash-preview`.
- Removed `generativelanguage.googleapis.com`.
- Added Kie-only config path using `readKieConfig('script_framework')`.
- Adapter is now `kie_openai_chat`.

### 5.2 Correct DB Sync Target Identified

Important discovery:

Running `node sync_iteration_v1_workflows_to_db.mjs` without env vars writes to the source dev DB:

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/.n8n/database.sqlite`

But the running RC app uses App Support DB:

- `/Users/drew/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite`

Correct sync command used:

```bash
N8N_DB_PATH="$HOME/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite" \
  node sync_iteration_v1_workflows_to_db.mjs
```

### 5.3 WF02a Kie Body Adapter Fixed

Modified same node:

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n02a.json`
- Node: `读取脚本API配置`

Added minimal body adapter:

- Reads Gemini-style body from `$json.request_body`.
- Converts `system_instruction.parts[].text` to OpenAI `system` message.
- Converts `contents[].parts[].text` to OpenAI `user` message.
- Outputs Kie/OpenAI-compatible request body:

```json
{
  "model": "gemini-3.1-pro",
  "messages": []
}
```

No prompt, node connection, image, storyboard, video, or model default was changed.

## 6. Verification Evidence

### 6.1 Static Checks

Source file check:

- File: `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n02a.json`
- JSON parse: passed
- `kie_openai_chat`: present
- `readKieConfig`: present
- `script_framework`: present
- `messages` conversion: present
- `kieBody`: present
- `generativelanguage.googleapis.com`: absent
- `gemini-3-flash-preview`: absent
- `readGeminiKey`: absent
- `isGoogleModel`: absent

App Support active DB check:

- DB: `/Users/drew/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite`
- Workflow: `scriptGenerateV1`
- DB version after D2: `fb6b1326-80e1-483c-9e44-947fdd1abd7e`
- Updated at: `2026-05-26 11:41:55.266`
- Same checks passed in active DB.

### 6.2 Runtime Checks

Execution history for `scriptGenerateV1`:

- `13`, `14`, `15`, `16`: error, old Google-native timeout around 315 seconds.
- `17`: error, Kie route fixed but request body still wrong, Kie returned `422 messages is required`.
- `18`: success after body adapter fix.

Execution `18`:

- Workflow: `scriptGenerateV1`
- Status: `success`
- Started: `2026-05-26 11:42:53.779`
- Stopped: `2026-05-26 11:43:51.188`
- All 13 nodes ran successfully.
- `提取脚本框架JSON` succeeded.
- `写脚本框架上下文` ran.
- Extracted 6 script shots.

No image model, video model, or Veo was triggered during this verification.

### 6.3 Current Script Context Output

Script context currently exists at the source dev path:

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/script-context/script_context_proj_1779792205843.json`

Observed:

- File exists: yes
- Size: `24415` bytes
- `project_id`: `proj_1779792205843`
- Shot-like field exists: yes
- Shot count: `6`

App Support target path is still missing:

- `/Users/drew/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/script-context/script_context_proj_1779792205843.json`

This is the next engineering problem.

## 7. Current Page State

The script review route was checked:

- URL: `http://127.0.0.1:18788/script-review?project_id=proj_1779792205843`
- HTTP 200: yes
- Contains `短视频执行表`: yes
- Contains `分镜图`: yes
- Contains project id: yes

Because this RC still falls back to the source dev path, the current local page can find the generated script framework. This does not mean the package is ready for a normal new user.

## 8. Remaining Critical Risk

Path isolation is not complete.

The workflow node `写脚本框架上下文` wrote to:

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/...`

It should write to:

- `/Users/drew/Library/Application Support/AI Video/workflow-data/...`

Reason found:

- The n8n subprocess in this RC does not appear to receive `WORKFLOW_DATA_ROOT`.
- The node falls back to `TIKTOK_WORKFLOW_ROOT` or the source directory.

This is a packaging blocker for ordinary-user delivery.

## 9. Next Minimal Work Order

Recommended next work order:

### P7-FIX-D3 / Path Isolation for Script Context

Goal:

Make WF02a `写脚本框架上下文` write to App Support workflow-data, not the source tree.

Allowed scope:

1. Inspect `client/launcher.mjs` env passed to n8n subprocess.
2. Inspect `版本测试/serve-review-assets.mjs` server path resolution.
3. Inspect WF02a `写脚本框架上下文` node path logic.
4. Minimal fix only:
   - Ensure `WORKFLOW_DATA_ROOT` is passed into n8n runtime / JS Task Runner, or
   - Ensure the node resolves App Support path consistently.

Forbidden:

1. Do not change prompt.
2. Do not change workflow business chain.
3. Do not change default models.
4. Do not run storyboard image generation.
5. Do not run video / Veo.
6. Do not upload GitHub Release.
7. Do not build DMG yet.

Acceptance:

1. Re-run WF02a for `proj_1779792205843` or a new low-cost test project.
2. Execution succeeds.
3. Script context is written under:
   `/Users/drew/Library/Application Support/AI Video/workflow-data/...`
4. Source dev `.n8n-local-cache/script-context` is not used for new output.
5. `/script-review?project_id=...` returns 200 from App Support data.
6. No image model, video model, or Veo is triggered.

## 10. Commands Useful For Next Review

Check source WF02a node:

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n02a.json')
data = json.loads(p.read_text())
node = next(n for n in data['nodes'] if n.get('name') == '读取脚本API配置')
code = node['parameters'].get('jsCode', '')
for label, ok in {
  'has_kie_openai_chat': 'kie_openai_chat' in code,
  'has_messages_conversion': 'messages.push' in code and 'request_body' in code,
  'no_google_host': 'generativelanguage.googleapis.com' not in code,
  'no_gemini_flash_preview': 'gemini-3-flash-preview' not in code,
}.items():
  print(label, ok)
PY
```

Check active App Support DB workflow:

```bash
DB="$HOME/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite" python3 - <<'PY'
import os, sqlite3, json
con = sqlite3.connect(os.environ['DB'])
row = con.execute("select versionId,updatedAt,nodes from workflow_entity where id='scriptGenerateV1'").fetchone()
print('versionId', row[0])
print('updatedAt', row[1])
nodes = json.loads(row[2])
node = next(n for n in nodes if n.get('name') == '读取脚本API配置')
code = node['parameters'].get('jsCode', '')
print('has_kie_openai_chat', 'kie_openai_chat' in code)
print('has_messages_conversion', 'messages.push' in code and 'request_body' in code)
print('no_google_host', 'generativelanguage.googleapis.com' not in code)
PY
```

Check latest WF02a executions:

```bash
DB="$HOME/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite"
sqlite3 "$DB" "select id,workflowId,status,startedAt,stoppedAt from execution_entity where workflowId='scriptGenerateV1' order by cast(id as integer) desc limit 8;"
```

Check current script-context locations:

```bash
test -f "$HOME/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/script-context/script_context_proj_1779792205843.json" && echo "source dev script context exists"
test -f "$HOME/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/script-context/script_context_proj_1779792205843.json" && echo "App Support script context exists"
```

## 11. Safety Notes

- Do not print any API key.
- Do not cat local config files.
- Do not grep secrets with matching lines.
- Use `--noproxy '*'` for localhost curl checks when needed.
- Do not kill unknown customer/system processes.
- There was one stale Claude monitor process waiting for App Support script-context; it was cleaned up after D2 review.

## 12. Current Bottom Line

Fixed:

- WF02a no longer uses stale Google-native route.
- WF02a now uses Kie `gemini-3.1-pro`.
- WF02a now converts request body to OpenAI-compatible `messages`.
- Script framework generation succeeded once and produced 6 shots.

Not fixed yet:

- WF02a output path still falls back to the source directory.
- This must be fixed before treating the app as a normal-user package.

