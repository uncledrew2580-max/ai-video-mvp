import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function getGeminiApiKey() {
  const keyFile = path.join(os.homedir(), '.n8n', 'gemini-api-key');
  try { const k = fs.readFileSync(keyFile, 'utf8').trim(); if (k) return k; } catch (e) {}
  const k = (process.env.GEMINI_API_KEY || '').trim();
  if (k) return k;
  throw new Error('veo-status: missing Gemini API key — write key to ~/.n8n/gemini-api-key or set GEMINI_API_KEY env');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const operationName = process.argv[2];
if (!operationName) {
  fail('veo-status: missing operation name');
}

const url = `https://generativelanguage.googleapis.com/v1beta/${operationName}`;

try {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-goog-api-key': getGeminiApiKey(),
    },
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    fail(
      JSON.stringify({
        error: `HTTP ${response.status}`,
        url,
        body,
      }),
    );
  }

  process.stdout.write(JSON.stringify(body));
} catch (error) {
  fail(
    JSON.stringify({
      error: error?.message || String(error),
      url,
    }),
  );
}
