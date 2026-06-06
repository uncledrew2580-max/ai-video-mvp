#!/usr/bin/env node
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const privateKeyPath = join(root, 'license-authority', 'ai-video-ed25519-private.pem');

function usage() {
  console.error([
    'Usage:',
    '  node tools/issue-license.mjs --device <DEVICE_ID> [--days 365] [--customer "客户名"]',
    '  node tools/issue-license.mjs --device <DEVICE_ID> --expires 2027-05-25 [--customer "客户名"]',
    '',
    'Options:',
    '  --device      客户激活页显示的设备 ID，必填',
    '  --days        有效天数，默认 365',
    '  --expires     到期日期 YYYY-MM-DD；优先级高于 --days',
    '  --customer    客户备注，可选',
    '  --license-id  授权编号，可选',
  ].join('\n'));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

const args = parseArgs(process.argv.slice(2));
if (!args.device || args.help) {
  usage();
  process.exit(args.help ? 0 : 1);
}

if (!existsSync(privateKeyPath)) {
  console.error(`找不到私钥：${privateKeyPath}`);
  process.exit(1);
}

const issuedAt = new Date();
const days = Number.parseInt(args.days || '365', 10);
const expiresAt = args.expires || toDateOnly(addDays(issuedAt, Number.isFinite(days) ? days : 365));
const licenseId = args.licenseId || `AIV-${issuedAt.toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const deviceId = String(args.device).trim().toUpperCase();

const payload = {
  app_id: 'ai-video-mvp',
  license_id: licenseId,
  customer: String(args.customer || '').trim(),
  device_id: deviceId,
  issued_at: issuedAt.toISOString(),
  expires_at: expiresAt,
};

const privateKey = readFileSync(privateKeyPath, 'utf8');
const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
const signatureB64 = crypto.sign(null, Buffer.from(payloadB64), privateKey).toString('base64url');
const code = `AIV1.${payloadB64}.${signatureB64}`;

console.log('');
console.log('Activation code:');
console.log(code);
console.log('');
console.log('Payload:');
console.log(JSON.stringify(payload, null, 2));
