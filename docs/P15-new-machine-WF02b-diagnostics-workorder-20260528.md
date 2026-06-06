# P15 - New Machine WF02b Storyboard Failure Evidence and Fix Coordination

Date: 2026-05-28

## Current status

The 0849 internal-test DMG has been installed on a clean/new Mac user environment.

Observed on the new machine:

- WF01 `TikTok主流程｜表单→创意方向`: success
- WF02a `TikTok续跑｜创意确认→脚本框架`: success
- WF02b `TikTok续跑｜脚本确认→分镜图生成`: error
- Latest known WF02b execution: `5`
- Failing node: `分镜提示响应适配`
- Error: `Messages must contain at least one prompt [line 26]`

Interpretation:

- This failure happens before Nano Banana image generation.
- Kie showing `gemini-3.1-pro` for the failed request is expected, because WF02b first uses the text model to generate storyboard / Nano prompt content.
- `nano-banana-pro` has not been reached yet in this failing execution.
- A separate UI empty-state issue exists: `/pending-review` can fail when `.n8n-local-cache/review-context` does not exist yet. That is not the root cause of the WF02b API failure.

## Coordination rule

Do not let the new-machine Codex and local Claude Code independently edit the project in parallel.

Controlled sequence:

1. New-machine Codex performs read-only evidence collection.
2. Main Codex reviews the evidence and confirms the root cause.
3. Claude Code applies the minimal source fix in the main project.
4. Main Codex reviews Claude Code's patch.
5. A new RC / DMG is generated only after review.
6. The new machine either installs the new RC or applies the exact reviewed hotfix only if explicitly approved.
7. After the full chain runs, the new-machine app data can be cleaned only with explicit confirmation, then a clean full run is performed.

## Work order for new-machine Codex

Copy the following prompt into Codex on the new Mac.

---

You are diagnosing AI Video Mac MVP on this Mac. Do not modify any files. Do not trigger any workflow. Do not call Gemini, Nano Banana, Veo, or any paid API. Do not print API keys, Authorization headers, Bearer tokens, secrets, or full prompts.

Goal: collect evidence for the WF02b storyboard failure where the latest execution failed at `分镜提示响应适配` with `Messages must contain at least one prompt`.

Project runtime paths on this Mac should be under:

- `$HOME/Library/Application Support/AI Video`
- n8n DB: `$HOME/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite`
- logs: `$HOME/Library/Application Support/AI Video/logs`

Please perform only read-only checks.

### A. Confirm runtime and latest executions

Run read-only SQLite queries:

```bash
DB="$HOME/Library/Application Support/AI Video/n8n-user/.n8n/database.sqlite"
/usr/bin/sqlite3 "$DB" "select e.id,e.workflowId,w.name,e.status,e.finished,e.startedAt,e.stoppedAt from execution_entity e left join workflow_entity w on w.id=e.workflowId order by e.id desc limit 20;"
```

Then identify the latest `storyboardGenerateV1` execution.

### B. Extract redacted execution evidence

Inspect the latest `storyboardGenerateV1` execution data. Do not print API keys, auth headers, or full prompts.

Report:

- execution id
- workflow id
- status
- lastNodeExecuted
- top error message
- node-level error messages
- whether `分镜提示请求体适配` ran
- whether `_adapted_body.messages` exists
- number of messages
- roles of messages
- for each message, content type and character length only
- whether any message content is empty
- whether `model` is `gemini-3.1-pro`
- whether `tool_choice` is present
- whether Authorization / Bearer exists, but only output true/false, never the value
- whether `分镜提示响应适配` received a Kie API error envelope
- whether any Nano Banana node ran

If you use a script, sanitize output before printing. Never print raw `_api_key`, `_auth_header`, `Authorization`, `Bearer`, `secret`, or `token`.

### C. Inspect relevant logs

Read only the recent relevant lines from:

- `$HOME/Library/Application Support/AI Video/logs/launcher/n8n.log`
- `$HOME/Library/Application Support/AI Video/logs/launcher/ui-18788.log`
- diagnostics JSON if present under `$HOME/Library/Application Support/AI Video/logs/diagnostics`

Report only error summaries and paths. Do not print secrets.

### D. Check cache/context existence

Check whether these directories/files exist:

- `$HOME/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/concept-context`
- `$HOME/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/script-context`
- `$HOME/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/review-context`
- `$HOME/Library/Application Support/AI Video/workflow-data/.n8n-local-cache/review-progress`
- `$HOME/Library/Application Support/AI Video/workflow-data/project-history.json`

Output file counts and latest filenames only. Do not print full customer content.

### E. Required conclusion format

Output:

1. Latest WF02b execution id
2. Failing node
3. Exact error summary
4. Did `_adapted_body.messages` exist: yes/no
5. Message count
6. Message roles
7. Message content lengths
8. Any empty message content: yes/no
9. Was model `gemini-3.1-pro`: yes/no
10. Did Nano Banana run: yes/no
11. Was this before Nano: yes/no
12. Is this likely a WF02b text prompt request adapter problem: yes/no
13. Is `review-context` missing: yes/no
14. Is missing `review-context` root cause of WF02b failure: yes/no
15. Minimal next fix suggestion

Stop after reporting. Do not fix anything.

---

## Expected root-cause hypothesis to verify

The leading hypothesis is:

WF02b reaches the text storyboard prompt stage, but the Kie chat request body sent by `分镜提示请求体适配` does not contain at least one valid non-empty prompt according to Kie. This can happen if:

- upstream `request_body.system_instruction` and `request_body.contents` are missing or empty;
- the adapter produces an empty `messages` array or empty user content;
- the adapter sends a message structure that Kie rejects for this endpoint;
- unsupported request fields such as `tool_choice` contribute to Kie rejecting the request.

This must be confirmed from execution data before patching.

## New-machine evidence received

Received from the clean/new Mac user environment:

- Latest `storyboardGenerateV1` execution id: `5`
- Status: `error`
- Started: `2026-05-28 04:23:51.792`
- Stopped: `2026-05-28 04:23:53.254`
- Failing node: `分镜提示响应适配`
- Error: `Kie API 错误 400；Messages must contain at least one prompt [line 26]`
- `分镜提示请求体适配` did run.
- `_adapted_body` exists.
- `_adapted_body.model`: `gemini-3.1-pro`
- `messages` count: `1`
- `messages` roles: `user`
- `messages[0].content` type: `array`
- `messages[0].content` length: `0`
- Empty prompt/content: yes
- `tool_choice`: present
- Authorization / Bearer: present, redacted by new-machine Codex
- Kie returned API-level `400`, no `choices`, no `candidates`
- Nano Banana nodes did not run.
- Nano task was not created.
- `concept-context`: exists, 1 file
- `script-context`: exists, 1 file
- `review-context`: absent
- `review-progress`: exists, 0 files
- `project-history.json`: absent

Conclusion from evidence:

- The failure is confirmed as a WF02B text prompt request assembly / adapter problem.
- The Kie dashboard showing `gemini-3.1-pro` is expected because the workflow fails before the Nano Banana image stage.
- `review-context` absence is a separate empty-state / initialization issue, not the root cause of the WF02B Kie 400.
- The immediate request sent to Kie was invalid because it contained a user message with empty array content.

## Minimal fix scope after evidence

If the hypothesis is confirmed, Claude Code should make only the following minimal fixes:

1. WF02b Kie text request adapter guard:
   - ensure Kie receives at least one non-empty text prompt;
   - prefer a plain non-empty user message string for the Kie OpenAI-compatible chat route;
   - do not change the business prompt, model, schema, workflow skeleton, node connections, or downstream field names;
   - if no prompt exists, fail locally with a clear diagnostic before calling Kie.

2. `/pending-review` empty-state guard:
   - create or tolerate missing `.n8n-local-cache/review-context`;
   - show an empty list / friendly Chinese message instead of `ENOENT`.

3. Verification:
   - no Veo unless separately authorized;
   - run only the minimum WF02b retest needed after the user confirms paid cost;
   - confirm Nano Banana is reached only after the text storyboard prompt succeeds.

## Do not do

- Do not change `gemini-3.1-pro`.
- Do not change `nano-banana-pro`.
- Do not change `veo3_lite`.
- Do not remove image input.
- Do not convert the chain to text-only.
- Do not edit workflow skeleton or node connections.
- Do not upload GitHub.
- Do not generate formal DMG.
- Do not clear App Support data without explicit approval.
