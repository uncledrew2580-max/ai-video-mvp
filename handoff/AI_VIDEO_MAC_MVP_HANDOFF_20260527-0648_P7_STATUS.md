# AI Video Mac MVP Handoff - 2026-05-27 06:48

## Current Objective

Package the frozen 2026-05-24 AI Video n8n workflow into a Mac client that a normal user can install, fill only their Kie API Key, and run without touching n8n or the source directory.

Frozen business route remains:

填表 + 产品图片 -> 创意方向 -> 选择方向 -> 脚本框架 -> 分镜图 -> 分镜裁切首帧 -> 图生视频 -> 最终成片

Frozen default models remain:

- Text: `gemini-3.1-pro`
- Image: `nano-banana-pro`
- Video: `veo3_lite`
- Base URL: `https://api.kie.ai/api`

No API Key or secret is included in this handoff.

## Important Paths

- Project root: `/Users/drew/Downloads/tiktok-n8n-workflow-pack`
- Current candidate app: `/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260526-1901/AI Video.app`
- Candidate app resource root: `/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260526-1901/AI Video.app/Contents/Resources/app`
- App Support root: `/Users/drew/Library/Application Support/AI Video`
- n8n DB: `/Users/drew/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite`
- n8n log: `/Users/drew/Library/Application Support/AI Video/logs/launcher/n8n.log`
- UI log: `/Users/drew/Library/Application Support/AI Video/logs/launcher/ui-18788.log`
- n8n event log: `/Users/drew/Library/Application Support/AI Video/n8n-user/.n8n/n8nEventLog.log`
- Test project: `proj_1779806424534`

## Role / Process Note

The intended process is Codex review + Claude Code execution. During P7-D2 the Claude bridge became unreliable and stalled after repeated prompts. To keep the night run moving, Codex performed a mechanical patch directly and then reviewed it. This should be disclosed in any later audit.

## Completed Evidence

### P7-FIX Creative Direction

- WF01 execution `24`
- Status: `success`
- Workflow: `rKHHjD2QBlL6EhaM`
- Model: `gemini-3.1-pro`
- Evidence: image + form entered the first model call, concept context generated, front end displayed creative directions.

### Script Framework

- WF02a execution `27`
- Status: `success`
- Workflow: `scriptGenerateV1`
- Evidence: script review page showed 6 shots for project `proj_1779806424534`.

### Nano Banana Storyboard

- WF02b execution `33`
- Status: `success`
- Workflow: `storyboardGenerateV1`
- Model: `nano-banana-pro`
- Evidence: 6 storyboard panels generated and cropped.
- Main review context: `/Users/drew/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/review-context/review_context_proj_1779806424534_1_1779818939042.json`

## Video / WF03 State

### First WF03 Attempt

- Execution `34`
- Workflow: `reviewSubmitVeoV2`
- Status: `error`
- Last node: `逐镜视频_API_占位`
- Error type: JS Task Runner became unresponsive.
- No actual `veo3_lite` task was submitted.

### WF03 Mechanical Patch

Patched source and packaged workflow:

- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/正式导入文件/iteration-v1/n8n03.json`
- `/Users/drew/Downloads/tiktok-n8n-workflow-pack/release-candidates/AI-Video-Mac-MVP-20260526-1901/AI Video.app/Contents/Resources/app/正式导入文件/iteration-v1/n8n03.json`

Patch scope:

- Replaced blocking `execFileSync` / `Atomics.wait` usage in WF03 video nodes with async `spawn` + Promise.
- Affected nodes:
  - `逐镜视频_API_占位`
  - `Veo查询任务状态`
  - `Veo下载视频`
  - `Veo结果汇总`
- No business route changes.
- No model changes.
- No prompt/business content changes.

Verification:

- Both source and packaged `n8n03.json` have sha256:
  `ff347222933250932798aa23191780ce206b673715cf7e689150531a038616ae`
- No WF03 Code node contains `execFileSync` or `Atomics.wait`.
- WF03 Code node syntax checks passed.
- WF03 active in DB after sync/restart.

### Runtime Reload

The 1901 candidate app was restarted cleanly after patch/sync.

New process start times were around 2026-05-27 06:33:

- Electron app
- launcher
- n8n
- JS Task Runner
- UI asset server

Health checks:

- `http://127.0.0.1:5678/healthz` returned OK.
- `http://127.0.0.1:18788/` returned HTTP 200.
- WF03 webhook was registered:
  `reviewSubmitVeoV2/review_submit_resume/storyboard-review-submit-v2`

## Second WF03 Attempt After Patch

Triggered exactly once via:

- `POST http://127.0.0.1:18788/review-submit`
- Project: `proj_1779806424534`
- Review context: `/Users/drew/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/review-context/review_context_proj_1779806424534_1_1779818939042.json`

Result:

- Execution `35`
- Workflow: `reviewSubmitVeoV2`
- Status: `error`
- Started: `2026-05-26 22:35:09.147`
- Stopped: `2026-05-26 22:38:44.451`
- Last failed node: `逐镜视频_API_占位`
- Error summary: `Kie首帧图上传` failed with TLS handshake error:
  `sslv3 alert handshake failure`
- No video files were generated.
- No final video was generated.

Important distinction:

- The previous runner-blocking bug was fixed.
- Execution `35` reached the actual first-frame upload step.
- The current blocker is external Kie upload/API network reachability from this Mac/proxy environment.

## Network / Proxy Findings

Local system proxy settings point to:

- HTTP proxy: `127.0.0.1:7892`
- HTTPS proxy: `127.0.0.1:7892`
- SOCKS proxy: `127.0.0.1:7892`

Actual listener:

- `FlyingBird` is listening on `127.0.0.1:7892`

Observed behavior:

- Proxy works for `https://www.google.com/`.
- `https://api.kie.ai/...` fails with TLS handshake failure through the proxy.
- `https://kieai.redpandaai.co/...` fails with TLS/connection reset through the proxy.
- Direct local DNS for `kieai.redpandaai.co` fails on common public resolvers except AliDNS.
- Direct local resolution for `api.kie.ai` resolves to an unreachable private IPv6 tunnel address in this environment.
- Manual `curl` and Node HTTPS tests both fail for Kie endpoints from the current environment.

Current conclusion:

The app/workflow can now reach the video stage, but the Mac's current Kie network/proxy path cannot complete TLS to Kie upload/API endpoints. This is not a business logic failure and not a model-route failure.

## Current DB / Workflow State

Active workflows in DB:

- `rKHHjD2QBlL6EhaM`: active
- `scriptGenerateV1`: active
- `storyboardGenerateV1`: active
- `reviewSubmitVeoV2`: active

Execution evidence:

- `24|rKHHjD2QBlL6EhaM|success`
- `27|scriptGenerateV1|success`
- `33|storyboardGenerateV1|success`
- `34|reviewSubmitVeoV2|error`
- `35|reviewSubmitVeoV2|error`

## Current Blocking Issue

P7 video closed-loop is blocked at:

`逐镜视频_API_占位` -> `Kie首帧图上传`

Failure class:

External Kie upload/API network/proxy/TLS reachability.

It is not:

- Not a missing API Key issue.
- Not a model default issue.
- Not a missing image issue.
- Not a pure text fallback issue.
- Not a deleted image input issue.
- Not a JS Task Runner blocking issue anymore.

## Recommended Next Minimal Work Order

### P7-E-NET

Goal:

Make WF03 video-stage network calls reliably reach Kie from packaged runtime.

Allowed scope:

- n8n runtime network/proxy config for the app.
- WF03 implementation details for HTTP transport only, if needed.
- Diagnostics that do not print API Key.

Do not change:

- Frozen business route.
- Default models.
- Product image input.
- Prompt/business logic.
- Workflow stage order.

Acceptance:

- A no-secret connectivity check to Kie endpoints succeeds from the same runtime path used by n8n Code nodes.
- One controlled WF03 retry reaches actual `veo3_lite` task submission.
- If task submission succeeds, polling/download can continue.
- If Kie returns API-level error, classify by status/message without printing secrets.

Stop conditions:

- Do not retry repeatedly.
- Do not run more paid calls until Kie TLS/proxy reachability is confirmed.
- Do not upload GitHub Release.
- Do not generate DMG.

## Packaging Status

Do not treat the current candidate as final.

Reason:

- Creative direction, script, and storyboard are proven.
- WF03 video closed-loop is not complete because Kie upload/API network path is blocked.
- A new final release candidate should be generated only after P7 video passes or after the user explicitly accepts storyboard-only validation.

## Notes for Next Account / Session

Start by reading this file, then verify current runtime:

```bash
ps -axo pid=,ppid=,lstart=,command= | awk 'index($0,"AI-Video-Mac-MVP-20260526-1901/AI Video.app")>0 {print}'
curl --noproxy '*' -sS http://127.0.0.1:5678/healthz
curl --noproxy '*' -sS -o /tmp/ai-video-ui-check.html -w 'ui_http=%{http_code} size=%{size_download}\n' http://127.0.0.1:18788/
```

Check WF03 error:

```bash
sqlite3 "$HOME/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite" \
  "select id,workflowId,status,startedAt,stoppedAt from execution_entity where id in (34,35);"
```

Do not print or copy API Key values.
