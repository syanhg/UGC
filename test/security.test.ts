import { test } from 'node:test';
import assert from 'node:assert/strict';

import { within } from '../src/paths.ts';
import { assertPersonGeneration, parseResolution } from '../src/config.ts';
import { assertValidName, slugifyName } from '../src/avatars.ts';
import { redact } from '../src/generate.ts';

test('within() confines a path to its base', () => {
  assert.equal(within('/data', 'sofia'), '/data/sofia');
  assert.equal(within('/data', 'a/b'), '/data/a/b');

  for (const escape of ['..', '../..', 'a/../..', '/etc/passwd', '../.ssh']) {
    assert.throws(
      () => within('/data', escape),
      /resolves outside/,
      `"${escape}" should be refused`,
    );
  }
});

test('within() does not confuse a sibling prefix for a child', () => {
  assert.throws(() => within('/data', '../data-other'), /resolves outside/);
});

test('avatar names reject traversal and prototype keys', () => {
  for (const ok of ['sofia', 'marcus-2', 'a_b', 'Model1']) {
    assert.doesNotThrow(() => assertValidName(ok), `"${ok}" should be valid`);
  }

  for (const bad of ['..', '../x', 'a/b', '__proto__', 'constructor.x', '', '.env']) {
    assert.throws(() => assertValidName(bad), /invalid/i, `"${bad}" should be refused`);
  }
});

test('slugifyName produces names the registry accepts', () => {
  for (const layer of ['Young Woman / Selfie', "Sofia's face!", '  spaced  ']) {
    assert.doesNotThrow(() => assertValidName(slugifyName(layer)));
  }
});

test('personGeneration refuses allow_all', () => {
  assert.equal(assertPersonGeneration('allow_adult'), 'allow_adult');
  assert.equal(assertPersonGeneration('dont_allow'), 'dont_allow');

  assert.throws(() => assertPersonGeneration('allow_all'), /permits generating minors/);
  assert.throws(() => assertPersonGeneration('anything'), /must be/);
});

test('redact strips API keys in every shape they appear', () => {
  const key = 'AIzaSyD-fake-key-for-testing-000000000';
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;

  const cases = [
    `GET https://x.test/v1/files?key=${key}&alt=media failed`,
    `headers: {"x-goog-api-key": "${key}"}`,
    `authorization: Bearer ${key}`,
    `plain mention of ${key} in prose`,
    `?api_key=${key}`,
  ];

  for (const message of cases) {
    const out = redact(message);
    assert.ok(!out.includes(key), `key leaked through: ${out}`);
    assert.match(out, /<redacted>/);
  }
});

test('redact leaves ordinary text alone and never crashes without a key', () => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  const message = 'Generation timed out after 10 minutes';
  assert.equal(redact(message), message);
});

test('resolution normalises to the long edge, as Veo expects', () => {
  assert.equal(parseResolution('720x1280'), '1280x720');
  assert.equal(parseResolution('1280x720'), '1280x720');
  assert.equal(parseResolution('1080x1920'), '1920x1080');
  assert.throws(() => parseResolution('720p'), /must look like/);
});
