/**
 * P13-B1 nonpaid tests — bundled-ffmpeg final-merge fix.
 *
 * Covers (no model calls, no n8n, no paid APIs):
 *  1. ffmpeg available + 6 clips  => merge succeeds, final file exists, final_merged_video_path set,
 *     stage derives to final_generated. (Real merge with the BUNDLED ffmpeg binary.)
 *  2. ffmpeg unavailable + 6 clips => no fake success; status final_merge_failed; final_merge_error
 *     recorded; explicit Chinese UI error wired in serve.
 *  3. clips incomplete            => no merge; expected/found counts recorded.
 *  + structural guardrails: workflow uses injected absolute ffmpeg (no bare PATH ffmpeg),
 *    launcher injects AI_VIDEO_FFMPEG_PATH, bundled binary exists/executable, diagnostics fields present.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const FFMPEG = path.join(ROOT, 'runtime', 'bin', 'ffmpeg');
const SERVE = fs.readFileSync(path.join(ROOT, '版本测试', 'serve-review-assets.mjs'), 'utf8');
const LAUNCHER = fs.readFileSync(path.join(ROOT, 'client', 'launcher.mjs'), 'utf8');
const N8N03 = JSON.parse(fs.readFileSync(path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n03.json'), 'utf8'));
const MERGE_CODE = N8N03.nodes.find((n) => n.name === 'Veo结果汇总').parameters.jsCode;

// ── Mirror of the node's merge decision (pure; reflects the workflow logic). ──
function decideMerge({ ffmpegExecutable, completedCount, totalPanels, mergeProducesFile = true }) {
  let status = 'running';
  if (completedCount >= totalPanels && totalPanels > 0) status = 'success';
  else if (completedCount > 0) status = 'partial_success';

  let finalMergedVideoPath = '';
  let finalMergeFailed = false;
  let finalMergeError = '';
  let mergeAttempted = false;

  if (status === 'success' && completedCount === totalPanels && totalPanels > 0) {
    mergeAttempted = true;
    if (!ffmpegExecutable) {
      status = 'final_merge_failed';
      finalMergeFailed = true;
      finalMergeError = 'ffmpeg 不可用';
    } else if (mergeProducesFile) {
      finalMergedVideoPath = '/tmp/final.mp4';
    } else {
      status = 'final_merge_failed';
      finalMergeFailed = true;
      finalMergeError = 'ffmpeg 执行完成但未生成有效成片文件';
    }
  }
  return { status, finalMergedVideoPath, finalMergeFailed, finalMergeError, mergeAttempted };
}

test('scenario 1: ffmpeg available + 6 clips => success + final path set', () => {
  const r = decideMerge({ ffmpegExecutable: true, completedCount: 6, totalPanels: 6 });
  assert.equal(r.status, 'success');
  assert.ok(r.finalMergedVideoPath, 'final_merged_video_path should be set');
  assert.equal(r.finalMergeFailed, false);
});

test('scenario 1 (real): bundled clean ffmpeg stream-copy-merges 6 clips into a playable final file', () => {
  assert.ok(fs.existsSync(FFMPEG), 'bundled ffmpeg missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13b1-'));
  try {
    // The clean LGPL build has NO libx264. Generate clips with a native LGPL encoder
    // (mpeg4) + native aac, all identical params, so concat -c copy can remux them.
    const clips = [];
    for (let i = 1; i <= 6; i++) {
      const clip = path.join(dir, `clip_${i}.mp4`);
      execFileSync(FFMPEG, [
        '-y', '-f', 'lavfi', '-i', `testsrc=duration=0.2:size=128x72:rate=10`,
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
        '-c:v', 'mpeg4', '-c:a', 'aac', '-pix_fmt', 'yuv420p', clip,
      ], { stdio: 'ignore', timeout: 30000 });
      assert.ok(fs.statSync(clip).size > 0, `clip ${i} not produced`);
      clips.push(clip);
    }
    // EXACT concat command the workflow now uses: stream copy, no re-encode.
    const listPath = path.join(dir, 'concat.txt');
    fs.writeFileSync(listPath, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const out = path.join(dir, 'final.mp4');
    execFileSync(FFMPEG, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', out,
    ], { stdio: 'ignore', timeout: 60000 });
    assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, 'final merged file not produced');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scenario 2: ffmpeg unavailable + 6 clips => final_merge_failed, not success', () => {
  const r = decideMerge({ ffmpegExecutable: false, completedCount: 6, totalPanels: 6 });
  assert.equal(r.status, 'final_merge_failed');
  assert.notEqual(r.status, 'success');
  assert.equal(r.finalMergedVideoPath, '');
  assert.equal(r.finalMergeFailed, true);
  assert.ok(r.finalMergeError, 'final_merge_error must be recorded');
});

test('scenario 2b: ffmpeg runs but produces no file => final_merge_failed', () => {
  const r = decideMerge({ ffmpegExecutable: true, completedCount: 6, totalPanels: 6, mergeProducesFile: false });
  assert.equal(r.status, 'final_merge_failed');
  assert.equal(r.finalMergedVideoPath, '');
  assert.ok(r.finalMergeError);
});

test('scenario 3: clips incomplete => no merge attempted', () => {
  const r = decideMerge({ ffmpegExecutable: true, completedCount: 4, totalPanels: 6 });
  assert.equal(r.mergeAttempted, false);
  assert.notEqual(r.status, 'success');
  assert.equal(r.finalMergedVideoPath, '');
});

test('workflow node uses injected absolute ffmpeg, never bare PATH ffmpeg', () => {
  assert.ok(MERGE_CODE.includes('AI_VIDEO_FFMPEG_PATH'), 'node does not read AI_VIDEO_FFMPEG_PATH');
  assert.ok(/runProcess\(ffmpegPath/.test(MERGE_CODE), 'node does not run ffmpegPath');
  assert.ok(!/runProcess\(\s*['"]ffmpeg['"]/.test(MERGE_CODE), 'node still spawns bare "ffmpeg" literal');
  // No more silent downgrade to partial_success on merge failure.
  assert.ok(MERGE_CODE.includes("status = 'final_merge_failed'"), 'node lacks final_merge_failed status');
});

test('workflow final merge uses stream copy, no GPL/nonfree encoder', () => {
  // P13-B1L: -c copy remux only. No re-encode, no x264/x265/fdk-aac fallback.
  assert.ok(MERGE_CODE.includes("'-c', 'copy'"), 'merge is not stream copy (-c copy)');
  for (const banned of ['libx264', 'libx265', 'libfdk', "'-crf'", "'-preset'"]) {
    assert.ok(!MERGE_CODE.includes(banned), `merge must not reference re-encode/GPL token: ${banned}`);
  }
  // Failure path must record final_merge_failed and never fall back to a GPL encoder.
  assert.ok(MERGE_CODE.includes("finalMergeError"), 'merge does not record final_merge_error');
});

test('LICENSE: bundled ffmpeg is clean LGPL (no gpl/nonfree/x264/x265/fdk-aac)', () => {
  assert.ok(fs.existsSync(FFMPEG), 'bundled ffmpeg missing');
  const ver = execFileSync(FFMPEG, ['-hide_banner', '-version'], { timeout: 15000 }).toString('utf8');
  const cfgLine = (ver.split('\n').find((l) => l.startsWith('configuration:')) || '');
  for (const banned of ['--enable-gpl', '--enable-nonfree', '--enable-libx264', '--enable-libx265', '--enable-libfdk-aac']) {
    assert.ok(!cfgLine.includes(banned), `bundled ffmpeg configuration contains forbidden flag: ${banned}`);
    assert.ok(!ver.includes(banned), `bundled ffmpeg -version contains forbidden flag: ${banned}`);
  }
  // Also reject any obvious GPL/nonfree external lib references in the config line.
  for (const banned of ['libx265', 'libx264', 'libfdk', 'nonfree', 'enable-gpl']) {
    assert.ok(!cfgLine.includes(banned), `config line references banned lib: ${banned}`);
  }
});

test('workflow node persists final-merge diagnostic fields', () => {
  for (const f of [
    'final_merge_failed:', 'final_merge_error:', 'final_merge_command_summary:',
    'ffmpeg_path:', 'ffmpeg_exists:', 'ffmpeg_executable:', 'ffmpeg_version:',
    'clips_expected_count:', 'clips_found_count:',
  ]) {
    assert.ok(MERGE_CODE.includes(f), `node missing diagnostic field: ${f}`);
  }
});

test('launcher injects AI_VIDEO_FFMPEG_PATH into n8n runtime', () => {
  assert.ok(LAUNCHER.includes("const FFMPEG_PATH ="), 'launcher lacks FFMPEG_PATH resolution');
  assert.ok(LAUNCHER.includes("'runtime', 'bin', 'ffmpeg'"), 'launcher does not point at bundled ffmpeg');
  assert.ok(LAUNCHER.includes('AI_VIDEO_FFMPEG_PATH: FFMPEG_PATH'), 'launcher does not inject AI_VIDEO_FFMPEG_PATH');
});

test('serve surfaces explicit Chinese merge-failed error + status label', () => {
  assert.ok(SERVE.includes('视频片段已生成，但最终合成失败。原因：ffmpeg 不可用 / 合成命令失败。请导出诊断包。'),
    'exact merge-failed UI error string missing');
  assert.ok(SERVE.includes("final_merge_failed:'视频片段已生成，最终合成失败'"), 'status label missing');
  assert.ok(SERVE.includes('_finalMergeFailedState'), 'merge-failed state gate missing');
});

test('serve diagnostics export includes ffmpeg/clips/final fields', () => {
  for (const f of [
    'diag.finalMerge', 'final_output_dir', 'final_merged_video_path', 'final_file_exists',
    'final_merge_error', 'final_merge_command_summary', 'ffmpeg_path', 'ffmpeg_exists',
    'ffmpeg_executable', 'ffmpeg_version', 'clips_expected_count', 'clips_found_count', 'clips:',
  ]) {
    assert.ok(SERVE.includes(f), `serve diagnostics missing: ${f}`);
  }
});

test('bundled ffmpeg exists, is executable, reports a version', () => {
  assert.ok(fs.existsSync(FFMPEG), 'bundled ffmpeg missing');
  fs.accessSync(FFMPEG, fs.constants.X_OK);
  const v = execFileSync(FFMPEG, ['-version'], { timeout: 15000 }).toString('utf8');
  assert.ok(/ffmpeg version/.test(v), 'ffmpeg -version output unexpected');
});
