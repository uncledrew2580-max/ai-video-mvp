import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GoogleGenAI } from '@google/genai';

function getGeminiApiKey() {
  const keyFile = path.join(os.homedir(), '.n8n', 'gemini-api-key');
  try { const k = fs.readFileSync(keyFile, 'utf8').trim(); if (k) return k; } catch (e) {}
  const k = (process.env.GEMINI_API_KEY || '').trim();
  if (k) return k;
  throw new Error('veo-sdk-submit: missing Gemini API key — write key to ~/.n8n/gemini-api-key or set GEMINI_API_KEY env');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const requestPath = process.argv[2];
if (!requestPath) {
  fail('veo-sdk-submit: missing request file path');
}
if (!fs.existsSync(requestPath)) {
  fail(`veo-sdk-submit: request file not found: ${requestPath}`);
}

let request;
try {
  request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
} catch (error) {
  fail(`veo-sdk-submit: invalid request json: ${error.message}`);
}

const imagePath = request.imagePath;
if (!imagePath || !fs.existsSync(imagePath)) {
  fail(`veo-sdk-submit: image file not found: ${imagePath || ''}`);
}

const mimeType = request.mimeType || 'image/jpeg';
const model = request.model || 'veo-3.1-fast-generate-preview';
const prompt = String(request.prompt || '').slice(0, 4000);
const config = {
  aspectRatio: request.config?.aspectRatio || '9:16',
  durationSeconds: Number(request.config?.durationSeconds || 8),
  resolution: request.config?.resolution || '720p',
  personGeneration: request.config?.personGeneration || 'allow_adult',
};

const imageBytes = fs.readFileSync(imagePath).toString('base64');
const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });

try {
  const operation = await ai.models.generateVideos({
    model,
    prompt,
    image: {
      imageBytes,
      mimeType,
    },
    config,
  });
  process.stdout.write(JSON.stringify(operation));
} catch (error) {
  const payload = {
    error: error?.message || String(error),
    stack: error?.stack || '',
    model,
    imagePath: path.resolve(imagePath),
  };
  fail(JSON.stringify(payload));
}
