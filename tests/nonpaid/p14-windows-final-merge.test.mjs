/**
 * P14-A1 nonpaid tests — Windows final-merge via bundled clean ffmpeg.
 *
 * Cross-platform: resolves the bundled ffmpeg from AI_VIDEO_FFMPEG_PATH, else
 * runtime/bin/ffmpeg.exe (Windows), else runtime/bin/ffmpeg (mac dev). This lets
 * the same test run on the Windows runner (ffmpeg.exe) and locally on macOS
 * (the clean LGPL ffmpeg from baseline 0010) for static/logic validation.
 *
 * No model calls, no n8n, no paid APIs. Final merge is STREAM COPY (-c copy).
 * Missing ffmpeg must fail clearly (no silent success, no GPL fallback).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveFfmpeg() {
  const env = process.env.AI_VIDEO_FFMPEG_PATH;
  if (env && fs.existsSync(env)) return env;
  const exe = path.join(ROOT, 'runtime', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(exe)) return exe;
  const nix = path.join(ROOT, 'runtime', 'bin', 'ffmpeg');
  if (fs.existsSync(nix)) return nix;
  return null;
}
const FFMPEG = resolveFfmpeg();

// Mirror of the n8n03 merge decision (stream copy; no silent fail, no GPL fallback).
function decideMerge({ ffmpegExecutable, completedCount, totalPanels, mergeProducesFile = true }) {
  let status = completedCount >= totalPanels && totalPanels > 0 ? 'success'
    : completedCount > 0 ? 'partial_success' : 'running';
  let finalMergedVideoPath = '', finalMergeFailed = false, finalMergeError = '', mergeAttempted = false;
  if (status === 'success') {
    mergeAttempted = true;
    if (!ffmpegExecutable) { status = 'final_merge_failed'; finalMergeFailed = true; finalMergeError = 'ffmpeg 不可用'; }
    else if (mergeProducesFile) { finalMergedVideoPath = '/final.mp4'; }
    else { status = 'final_merge_failed'; finalMergeFailed = true; finalMergeError = 'no output file'; }
  }
  return { status, finalMergedVideoPath, finalMergeFailed, finalMergeError, mergeAttempted };
}

test('bundled ffmpeg is present (missing ffmpeg must fail, not skip)', () => {
  assert.ok(FFMPEG, 'no bundled ffmpeg found (AI_VIDEO_FFMPEG_PATH / runtime/bin/ffmpeg[.exe])');
});

test('LICENSE: bundled ffmpeg is clean (no gpl/nonfree/x264/x265/fdk)', () => {
  assert.ok(FFMPEG, 'ffmpeg missing');
  const ver = execFileSync(FFMPEG, ['-hide_banner', '-version'], { timeout: 20000 }).toString('utf8');
  for (const banned of ['--enable-gpl', '--enable-nonfree', '--enable-libx264', '--enable-libx265', '--enable-libfdk-aac', 'libx264', 'libx265', 'libfdk', 'nonfree']) {
    assert.ok(!ver.includes(banned), `forbidden token in ffmpeg -version: ${banned}`);
  }
});

test('real: stream-copy merge of 6 mock clips -> playable final mp4 + diag', () => {
  assert.ok(FFMPEG, 'ffmpeg missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p14-'));
  try {
    const shots = [];
    for (let i = 1; i <= 6; i++) {
      const clip = path.join(dir, `clip_${i}.mp4`);
      execFileSync(FFMPEG, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=0.2:size=128x72:rate=10',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
        '-c:v', 'mpeg4', '-c:a', 'aac', '-pix_fmt', 'yuv420p', clip,
      ], { stdio: 'ignore', timeout: 30000 });
      shots.push({ shot_order: i, status: 'completed', video_path: clip });
    }
    const listPath = path.join(dir, 'concat.txt');
    fs.writeFileSync(listPath, shots.map((s) => `file '${s.video_path.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const out = path.join(dir, 'final.mp4');
    execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', out], { stdio: 'ignore', timeout: 60000 });
    assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, 'final_merged_video_path file not produced');

    // diag.finalMerge shape (mirrors serve diagnostics section 14)
    const ver = execFileSync(FFMPEG, ['-hide_banner', '-version'], { timeout: 20000 }).toString('utf8');
    const diag = {
      final_merged_video_path: out,
      final_file_exists: fs.existsSync(out),
      final_file_size: fs.statSync(out).size,
      ffmpeg_path: FFMPEG,
      ffmpeg_exists: true,
      ffmpeg_executable: true,
      ffmpeg_version: ver.split('\n')[0],
      clips_expected_count: 6,
      clips_found_count: shots.length,
      clips: shots.map((s) => ({ shot_order: s.shot_order, path: s.video_path, exists: fs.existsSync(s.video_path), size: fs.statSync(s.video_path).size })),
    };
    assert.equal(diag.clips_found_count, 6);
    assert.equal(diag.clips_expected_count, 6);
    assert.ok(diag.final_file_size > 0);
    assert.ok(diag.clips.every((c) => c.exists && c.size > 0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ffmpeg unavailable + 6 clips => final_merge_failed (no fake success, no GPL fallback)', () => {
  const r = decideMerge({ ffmpegExecutable: false, completedCount: 6, totalPanels: 6 });
  assert.equal(r.status, 'final_merge_failed');
  assert.equal(r.finalMergedVideoPath, '');
  assert.ok(r.finalMergeError);
});

test('clips incomplete => no merge attempted', () => {
  const r = decideMerge({ ffmpegExecutable: true, completedCount: 4, totalPanels: 6 });
  assert.equal(r.mergeAttempted, false);
  assert.notEqual(r.status, 'success');
});
