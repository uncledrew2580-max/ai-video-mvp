import assert from 'node:assert/strict';
import {
  maskSecret,
  redact,
  redactObject,
  redactString,
} from '../../app-server/shared/redact.mjs';

function assertMissing(haystack, needle, message) {
  assert.equal(String(haystack).includes(needle), false, message);
}

{
  const secret = 'sk-test1234567890abcdefghijklmnopqrstuvwxyz';
  const redacted = redactObject({ api_key: secret });
  assert.notEqual(redacted.api_key, secret);
  assert.match(redacted.api_key, /^sk-/);
  assertMissing(JSON.stringify(redacted), secret, 'api_key value must not survive redaction');
}

{
  const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz1234567890';
  const line = `Authorization: ${bearer}`;
  const redacted = redactString(line);
  assert.equal(redacted, 'Authorization: [REDACTED-AUTHORIZATION]');
  assertMissing(redacted, bearer, 'Authorization Bearer token must be fully redacted');
}

{
  const token = 'tok_abcdefghijklmnopqrstuvwxyz1234567890';
  const apiKey = 'Kieabcdefghijklmnopqrstuvwxyz1234567890';
  const url = `https://example.test/run?token=${token}&api_key=${apiKey}&page=1`;
  const redacted = redactString(url);
  assertMissing(redacted, token, 'URL token must be redacted');
  assertMissing(redacted, apiKey, 'URL api_key must be redacted');
  assert.match(redacted, /page=1/);
}

{
  const license = 'LIC-1234567890-ABCDEFGHIJKLMNOP';
  const redacted = redactObject({ license_key: license });
  assertMissing(JSON.stringify(redacted), license, 'license key must be redacted');
  assert.match(redacted.license_key, /^LIC/);
}

{
  const input = {
    product_name: 'Glow Bottle',
    target_market: 'United States',
    target_language: 'English',
    providers: {
      kie: {
        api_key: 'Kieabcdefghijklmnopqrstuvwxyz9876543210',
      },
    },
    nested: {
      authorization: 'Bearer nestedabcdefghijklmnopqrstuvwxyz1234567890',
      callback_url: 'https://example.test/cb?secret=secretabcdefghijklmnopqrstuvwxyz1234567890',
    },
  };
  const redacted = redact(input);
  assert.equal(redacted.product_name, 'Glow Bottle');
  assert.equal(redacted.target_market, 'United States');
  assert.equal(redacted.target_language, 'English');
  assertMissing(JSON.stringify(redacted), input.providers.kie.api_key, 'nested api_key must be redacted');
  assertMissing(JSON.stringify(redacted), input.nested.authorization, 'nested authorization must be redacted');
  assertMissing(JSON.stringify(redacted), 'secretabcdefghijklmnopqrstuvwxyz1234567890', 'nested URL secret must be redacted');
  assert.equal(input.providers.kie.api_key, 'Kieabcdefghijklmnopqrstuvwxyz9876543210', 'redaction must not mutate input');
}

{
  const ordinary = {
    product_name: 'Portable Espresso Maker',
    target_market: 'Germany',
    target_language: 'German',
    creative_task_type: 'story_drama',
  };
  assert.deepEqual(redactObject(ordinary), ordinary);
}

{
  const longSecret = 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG';
  const redacted = redactString(`request id ${longSecret} completed`);
  assertMissing(redacted, longSecret, 'long secret-like string must be redacted');
}

{
  assert.equal(maskSecret('abc123xyz'), 'abc****xyz');
  assert.equal(maskSecret('short'), '[REDACTED]');
}

console.log('redact nonpaid tests passed');

