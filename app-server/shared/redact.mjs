const DEFAULT_VISIBLE_PREFIX = 3;
const DEFAULT_VISIBLE_SUFFIX = 3;

const SENSITIVE_FIELD_NAMES = new Set([
  'apikey',
  'api_key',
  'api-key',
  'key',
  'token',
  'secret',
  'authorization',
  'auth',
  'bearer',
  'license',
  'licensekey',
  'license_key',
  'license-key',
  'access_token',
  'access-token',
  'accesstoken',
  'refresh_token',
  'refresh-token',
  'refreshtoken',
  'client_secret',
  'client-secret',
  'clientsecret',
  'password',
  'credential',
  'credentials',
]);

const FIELD_NAME_PATTERN = [
  'api[_-]?key',
  'apiKey',
  'key',
  'token',
  'secret',
  'authorization',
  'auth',
  'bearer',
  'license(?:[_-]?key)?',
  'access[_-]?token',
  'accessToken',
  'refresh[_-]?token',
  'refreshToken',
  'client[_-]?secret',
  'clientSecret',
  'password',
  'credentials?',
].join('|');

function normalizeFieldName(fieldName) {
  return String(fieldName || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

export function isSensitiveField(fieldName) {
  const normalized = normalizeFieldName(fieldName);
  const compact = normalized.replace(/[-_]/g, '');
  return SENSITIVE_FIELD_NAMES.has(normalized) || SENSITIVE_FIELD_NAMES.has(compact);
}

export function maskSecret(value, options = {}) {
  const text = String(value ?? '');
  if (!text) return '';

  const visiblePrefix = Number.isFinite(options.visiblePrefix)
    ? Math.max(0, options.visiblePrefix)
    : DEFAULT_VISIBLE_PREFIX;
  const visibleSuffix = Number.isFinite(options.visibleSuffix)
    ? Math.max(0, options.visibleSuffix)
    : DEFAULT_VISIBLE_SUFFIX;

  if (options.full) return '[REDACTED]';
  if (text.length <= visiblePrefix + visibleSuffix + 2) return '[REDACTED]';

  return `${text.slice(0, visiblePrefix)}****${text.slice(-visibleSuffix)}`;
}

function redactFieldValue(fieldName, value) {
  if (/authorization|bearer|auth/i.test(String(fieldName || ''))) {
    return '[REDACTED-AUTHORIZATION]';
  }
  return maskSecret(value);
}

function redactKnownKeyPatterns(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, (match) => maskSecret(match))
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, (match) => maskSecret(match))
    .replace(/\bKie[A-Za-z0-9_-]{10,}\b/g, (match) => maskSecret(match));
}

function redactAuthorizationHeaders(text) {
  return text
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, 'Authorization: [REDACTED-AUTHORIZATION]')
    .replace(/\bAuthorization\s*:\s*(?!\[REDACTED-AUTHORIZATION\])[^\r\n,;]+/gi, 'Authorization: [REDACTED-AUTHORIZATION]');
}

function redactUrlQuerySecrets(text) {
  const queryPattern = new RegExp(`([?&])(${FIELD_NAME_PATTERN}=)([^&#\\s]+)`, 'gi');
  return text.replace(queryPattern, (_match, separator, keyPart, rawValue) => {
    const fieldName = keyPart.slice(0, -1);
    return `${separator}${keyPart}${redactFieldValue(fieldName, rawValue)}`;
  });
}

function redactFieldAssignments(text) {
  const assignmentPattern = new RegExp(`\\b(${FIELD_NAME_PATTERN})(\\b\\s*[:=]\\s*["']?)([^"',\\s&}]+)`, 'gi');
  return text.replace(assignmentPattern, (_match, fieldName, separator, rawValue) => {
    return `${fieldName}${separator}${redactFieldValue(fieldName, rawValue)}`;
  });
}

function redactLongSecretLikeStrings(text) {
  return text.replace(
    /\b(?=[A-Za-z0-9._~+/=-]{32,}\b)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{32,}\b/g,
    (match) => maskSecret(match),
  );
}

export function redactString(value) {
  let text = String(value ?? '');
  text = redactAuthorizationHeaders(text);
  text = redactUrlQuerySecrets(text);
  text = redactFieldAssignments(text);
  text = redactKnownKeyPatterns(text);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED]');
  text = redactLongSecretLikeStrings(text);
  return text;
}

export function redactObject(value, seen = new WeakMap()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';

  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(redactObject(item, seen));
    return out;
  }

  const out = {};
  seen.set(value, out);
  for (const [key, fieldValue] of Object.entries(value)) {
    if (isSensitiveField(key)) {
      out[key] = typeof fieldValue === 'string'
        ? redactFieldValue(key, fieldValue)
        : '[REDACTED]';
    } else {
      out[key] = redactObject(fieldValue, seen);
    }
  }
  return out;
}

export function redact(value) {
  return typeof value === 'string' ? redactString(value) : redactObject(value);
}

export { redactString as redactSensitiveText };
