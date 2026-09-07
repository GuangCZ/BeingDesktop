'use strict';

const DEFAULTS = Object.freeze({ chatFontSize: 14, codeFontSize: 12 });
const ALLOWED_CHAT_SIZES = Object.freeze([14, 15, 16]);
const ALLOWED_CODE_SIZES = Object.freeze([12, 13, 14]);
const INVALID_CONFIGURATION = 'Invalid typography configuration.';

function isPlainObject(value) {
  return value !== null && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype;
}

function allowedSize(value, allowed) {
  return typeof value === 'number' && Number.isFinite(value)
    && Number.isInteger(value) && allowed.includes(value);
}

function dataValue(descriptor) {
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function normalizeTypography(value) {
  try {
    if (!isPlainObject(value)) return { ...DEFAULTS };
    // Read only own data properties; disk recovery must not invoke accessors.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const chatFontSize = dataValue(descriptors.chatFontSize);
    const codeFontSize = dataValue(descriptors.codeFontSize);
    return {
      chatFontSize: allowedSize(chatFontSize, ALLOWED_CHAT_SIZES) ? chatFontSize : DEFAULTS.chatFontSize,
      codeFontSize: allowedSize(codeFontSize, ALLOWED_CODE_SIZES) ? codeFontSize : DEFAULTS.codeFontSize,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function validateTypography(value) {
  try {
    if (!isPlainObject(value)) throw new Error(INVALID_CONFIGURATION);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('chatFontSize') || !keys.includes('codeFontSize')) {
      throw new Error(INVALID_CONFIGURATION);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const chatFontSize = dataValue(descriptors.chatFontSize);
    const codeFontSize = dataValue(descriptors.codeFontSize);
    if (!allowedSize(chatFontSize, ALLOWED_CHAT_SIZES) || !allowedSize(codeFontSize, ALLOWED_CODE_SIZES)) {
      throw new Error(INVALID_CONFIGURATION);
    }
    return { chatFontSize, codeFontSize };
  } catch {
    // Keep IPC errors independent of caller-controlled values or proxy traps.
    throw new Error(INVALID_CONFIGURATION);
  }
}

function typographyCSS(value) {
  const { chatFontSize, codeFontSize } = validateTypography(value);
  return `:root { --text-chat: ${chatFontSize}px !important; --text-code: ${codeFontSize}px !important; }`;
}

module.exports = { normalizeTypography, validateTypography, typographyCSS };
