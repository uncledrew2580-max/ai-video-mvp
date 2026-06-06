import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function getGeminiApiKey() {
  const keyFile = path.join(os.homedir(), '.n8n', 'gemini-api-key');
  try { const k = fs.readFileSync(keyFile, 'utf8').trim(); if (k) return k; } catch (e) {}
  const k = (process.env.GEMINI_API_KEY || '').trim();
  if (k) return k;
  throw new Error('veo-download: missing Gemini API key — write key to ~/.n8n/gemini-api-key or set GEMINI_API_KEY env');
}

const OUTPUT_DIR = process.env.VIDEO_OUTPUT_DIR ||
  path.join(process.env.WORKFLOW_DATA_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'AI Video', 'workflow-data'), '.n8n-local-cache', 'videos');

function fail(message) {
  console.error(message);
  process.exit(1);
}

let payload = {};
try {
  payload = JSON.parse(process.argv[2] || '{}');
} catch (error) {
  fail(`veo-download: invalid payload: ${error.message}`);
}

const videoUri = payload.video_uri || '';
if (!videoUri) {
  fail('veo-download: missing video_uri');
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+$/, '')
  .replace('T', '_');
const fileName = `veo_${payload.project_id || 'proj'}_${payload.shot_id || 'shot_x'}_${stamp}.mp4`;
const fullPath = path.join(OUTPUT_DIR, fileName);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

try {
  const response = await fetch(videoUri, {
    method: 'GET',
    headers: {
      'x-goog-api-key': getGeminiApiKey(),
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    const text = await response.text();
    fail(
      JSON.stringify({
        error: `HTTP ${response.status}`,
        videoUri,
        body: text.slice(0, 2000),
      }),
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(fullPath, Buffer.from(arrayBuffer));

  process.stdout.write(
    JSON.stringify({
      video_model: payload.video_model || '',
      veo_video_path: fullPath,
      final_video_file_name: fileName,
      saved_to_local: true,
    }),
  );
} catch (error) {
  fail(
    JSON.stringify({
      error: error?.message || String(error),
      videoUri,
    }),
  );
}
