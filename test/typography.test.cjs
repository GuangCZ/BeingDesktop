'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTypography, validateTypography, typographyCSS } = require('../src/typography.cjs');

const DEFAULTS = { chatFontSize: 14, codeFontSize: 12 };
const INVALID_CONFIGURATION = { name: 'Error', message: 'Invalid typography configuration.' };

test('disk normalization recovers missing and malformed records', () => {
  for (const value of [undefined, null, false, 14, '15', [], new Date(), new Number(14)]) {
    assert.deepEqual(normalizeTypography(value), DEFAULTS);
  }
  assert.deepEqual(normalizeTypography({}), DEFAULTS);
});

test('disk normalization recovers each field independently without coercion', () => {
  for (const invalid of [undefined, null, false, '15', NaN, Infinity, -Infinity, 14.5, -1, 0, 100, {}]) {
    assert.deepEqual(normalizeTypography({ chatFontSize: invalid, codeFontSize: 13 }),
      { chatFontSize: 14, codeFontSize: 13 });
    assert.deepEqual(normalizeTypography({ chatFontSize: 16, codeFontSize: invalid }),
      { chatFontSize: 16, codeFontSize: 12 });
  }
  assert.deepEqual(normalizeTypography({ chatFontSize: 16 }), { chatFontSize: 16, codeFontSize: 12 });
  assert.deepEqual(normalizeTypography({ codeFontSize: 14 }), { chatFontSize: 14, codeFontSize: 14 });
});

test('disk normalization retains valid fields and discards unknown stored fields', () => {
  const input = Object.freeze({ chatFontSize: 15, codeFontSize: 13, futureSetting: true });
  assert.deepEqual(normalizeTypography(input), { chatFontSize: 15, codeFontSize: 13 });
  assert.equal(input.futureSetting, true);
});

test('valid configurations and exact CSS are supported for every permitted combination', () => {
  for (const chatFontSize of [14, 15, 16]) {
    for (const codeFontSize of [12, 13, 14]) {
      const input = Object.freeze({ chatFontSize, codeFontSize });
      assert.deepEqual(normalizeTypography(input), input);
      const validated = validateTypography(input);
      assert.deepEqual(validated, input);
      assert.notEqual(validated, input);
      assert.equal(typographyCSS(input),
        `:root { --text-chat: ${chatFontSize}px !important; --text-code: ${codeFontSize}px !important; }`);
    }
  }
});

test('strict validation requires a plain object with both fields', () => {
  for (const input of [undefined, null, false, 14, '14', [], {},
    { chatFontSize: 14 }, { codeFontSize: 12 }, new Date(),
    Object.assign(Object.create(null), DEFAULTS),
    Object.assign(new (class Typography {})(), DEFAULTS)]) {
    assert.throws(() => validateTypography(input), INVALID_CONFIGURATION);
  }
});

test('strict validation rejects every out-of-enum or non-number field', () => {
  const invalid = [undefined, null, true, '', '14', 0, -1, 13.5, 17, NaN, Infinity, -Infinity,
    new Number(14), 14n, Symbol('size'), [], {}];
  for (const value of invalid) {
    assert.throws(() => validateTypography({ chatFontSize: value, codeFontSize: 12 }), INVALID_CONFIGURATION);
    assert.throws(() => validateTypography({ chatFontSize: 14, codeFontSize: value }), INVALID_CONFIGURATION);
  }
  assert.throws(() => validateTypography({ chatFontSize: 13, codeFontSize: 12 }), INVALID_CONFIGURATION);
  assert.throws(() => validateTypography({ chatFontSize: 14, codeFontSize: 15 }), INVALID_CONFIGURATION);
});

test('unknown string, symbol, and non-enumerable keys are rejected', () => {
  const hiddenKey = Object.defineProperty({ ...DEFAULTS }, 'unexpected', { value: true });
  for (const input of [{ ...DEFAULTS, unexpected: true },
    { ...DEFAULTS, [Symbol('unexpected')]: true }, hiddenKey]) {
    assert.throws(() => validateTypography(input), INVALID_CONFIGURATION);
  }
});

test('inherited fields and prototype payloads cannot become validated settings', () => {
  const inherited = Object.create({ chatFontSize: 16, codeFontSize: 14 });
  const ownWithAlteredPrototype = Object.assign(Object.create({ injected: true }), DEFAULTS);
  const prototypePayload = JSON.parse('{"chatFontSize":16,"codeFontSize":14,"__proto__":{"polluted":true}}');
  for (const input of [inherited, ownWithAlteredPrototype, prototypePayload,
    { ...DEFAULTS, constructor: {} }, { ...DEFAULTS, prototype: {} }]) {
    assert.throws(() => validateTypography(input), INVALID_CONFIGURATION);
  }
  assert.deepEqual(normalizeTypography(inherited), DEFAULTS);
  assert.deepEqual(normalizeTypography(ownWithAlteredPrototype), DEFAULTS);
  const recovered = normalizeTypography(prototypePayload);
  assert.deepEqual(recovered, { chatFontSize: 16, codeFontSize: 14 });
  assert.equal(Object.getPrototypeOf(recovered), Object.prototype);
  assert.equal(Object.hasOwn(recovered, '__proto__'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('accessors are never executed by validation or normalization', () => {
  let reads = 0;
  const input = { get chatFontSize() { reads += 1; return 16; }, codeFontSize: 13 };
  assert.deepEqual(normalizeTypography(input), { chatFontSize: 14, codeFontSize: 13 });
  assert.throws(() => validateTypography(input), INVALID_CONFIGURATION);
  assert.throws(() => typographyCSS(input), INVALID_CONFIGURATION);
  assert.equal(reads, 0);
});

test('hostile reflection errors become fixed errors without caller text', () => {
  const input = new Proxy({}, { getPrototypeOf() { throw new Error('caller-controlled private text'); } });
  assert.deepEqual(normalizeTypography(input), DEFAULTS);
  assert.throws(() => validateTypography(input), INVALID_CONFIGURATION);
});

test('CSS generation rejects unvalidated values instead of silently normalizing them', () => {
  for (const input of [undefined, {}, { chatFontSize: '16', codeFontSize: 12 },
    { chatFontSize: '14px; } body { display:none', codeFontSize: 12 },
    { ...DEFAULTS, style: 'body { display:none }' }]) {
    assert.throws(() => typographyCSS(input), INVALID_CONFIGURATION);
  }
});

test('returned settings are independent and cannot mutate later defaults', () => {
  const first = normalizeTypography(undefined);
  first.chatFontSize = 99;
  assert.deepEqual(normalizeTypography(undefined), DEFAULTS);
  const input = { chatFontSize: 16, codeFontSize: 14 };
  const normalized = normalizeTypography(input);
  const validated = validateTypography(input);
  normalized.chatFontSize = 15;
  validated.codeFontSize = 13;
  assert.deepEqual(input, { chatFontSize: 16, codeFontSize: 14 });
});
