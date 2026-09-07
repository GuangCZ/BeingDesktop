'use strict';

const {endpoint, publicModelUrl} = require('./security.cjs');

// Loom's public loadLlmConfig/llmApply contract: GET returns presets;
// PATCH accepts model/provider/base_url/api_key and reports needs_key/rolled_back.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROVIDERS = {
  anthropic: {name: 'Anthropic', baseUrl: 'https://api.anthropic.com'},
  'openai-responses': {name: 'OpenAI Responses', baseUrl: 'https://api.openai.com/v1'},
  deepseek: {name: 'DeepSeek', baseUrl: 'https://api.deepseek.com'},
  kimi: {name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1'},
  google: {name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com'},
  openrouter: {name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1'},
};
const MESSAGES = {
  NOT_CONNECTED: '请先配置 Being 连接。',
  SESSION_CHANGED: 'Being 连接已变化，请重新读取模型配置。',
  BUSY: '正在保存模型配置，请稍后重新读取。',
  AUTH_REQUIRED: '模型配置授权失败，请检查 Loom 连接凭据。',
  NETWORK_ERROR: '模型配置读取失败，请检查网络与连接凭据。',
  INVALID_RESPONSE: '模型配置返回格式无效，请重新读取。',
  RESULT_UNKNOWN: '保存结果尚未确认，请重新读取当前配置后检查。',
  NEEDS_KEY: '此服务需要 API Key，请填写后重新保存。',
  ROLLED_BACK: 'Being 已回退本次模型变更，请重新读取当前配置。',
};
function failure(code, message = MESSAGES[code]) { const error = new Error(message); error.code = code; return error; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function plainText(value, limit) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : '';
}
function providerDetails(id) { return {id, name: PROVIDERS[id]?.name || id, baseUrl: PROVIDERS[id]?.baseUrl || ''}; }
function modelConfigDto(value, connectionId, checkedAt = new Date().toISOString()) {
  if (!record(value) || typeof value.model !== 'string' || typeof value.provider !== 'string') throw failure('INVALID_RESPONSE');
  const config = {
    model: plainText(value.model, 512), provider: plainText(value.provider, 100), baseUrl: publicModelUrl(value.base_url),
    hasApiKey: typeof value.has_api_key === 'boolean' ? value.has_api_key : null,
    thinking: plainText(value.thinking, 100), temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature) ? value.temperature : null,
    sbsEnabled: typeof value.sbs_enabled === 'boolean' ? value.sbs_enabled : null,
  };
  const models = [], seen = new Set();
  if (Array.isArray(value.presets)) {
    for (const preset of value.presets.slice(0, 2000)) {
      if (!record(preset) || typeof preset.model !== 'string' || typeof preset.provider !== 'string') continue;
      const id = plainText(preset.model, 512), provider = plainText(preset.provider, 100);
      const unique = JSON.stringify([provider, id]);
      if (!id || !provider || seen.has(unique)) continue;
      seen.add(unique);
      models.push({id, presetId: plainText(preset.id, 512), name: plainText(preset.label, 512) || id, provider,
        baseUrl: publicModelUrl(preset.base_url),
        hasApiKey: typeof preset.has_key === 'boolean' ? preset.has_key : null});
    }
  }
  const providerIds = [...new Set([config.provider, ...models.map(model => model.provider), ...Object.keys(PROVIDERS)].filter(Boolean))];
  return {connectionId, checkedAt, config, models, providers: providerIds.map(providerDetails),
    modelsError: Array.isArray(value.presets) ? '' : '此 Being 未提供支持模型列表，可填写自定义模型。'};
}

function validateModelPatch(value) {
  const allowed = ['connectionId', 'model', 'provider', 'baseUrl', 'apiKey'];
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => !allowed.includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))
      || !Number.isSafeInteger(value.connectionId) || value.connectionId < 0) throw failure('INVALID_REQUEST', '模型配置格式无效，请重新读取。');
  function field(key, name, limit, optional = false) {
    const input = value[key];
    if (optional && input === undefined) return '';
    if (typeof input !== 'string' || input.length > limit || /[\x00-\x1f\x7f]/.test(input)) throw failure('INVALID_REQUEST', `${name}格式无效。`);
    const result = input.trim();
    if (!optional && !result) throw failure('INVALID_REQUEST', `请填写${name}。`);
    return result;
  }
  const model = field('model', '模型名称', 512), provider = field('provider', '服务商', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider)) throw failure('INVALID_REQUEST', '服务商格式无效。');
  const baseUrl = field('baseUrl', 'API 地址', 2048, true), apiKey = field('apiKey', 'API Key', 16384, true);
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw failure('INVALID_REQUEST', '请填写有效的 HTTP 或 HTTPS API 地址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw failure('INVALID_REQUEST', 'API 地址须使用 HTTP 或 HTTPS，且不能包含凭据、查询参数或片段。');
    }
  }
  return {model, provider, ...(baseUrl ? {base_url: baseUrl} : {}), ...(apiKey ? {api_key: apiKey} : {})};
}

async function responseJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE');
  const reader = response.body?.getReader();
  if (!reader) throw failure('INVALID_RESPONSE');
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE');
      chunks.push(Buffer.from(part.value));
    }
  } finally { try { await reader.cancel(); } catch { /* Completed response bodies need no cancellation. */ } }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('INVALID_RESPONSE'); }
}

class ModelConfig {
  constructor({getContext, fetchImpl = globalThis.fetch}) {
    this.getContext = getContext;
    this.fetchImpl = fetchImpl;
    this.operation = null;
    this.snapshot = null;
    this.revision = 0;
  }
  get busy() {
    const current = this.getContext();
    return Boolean(this.operation && current.connection === this.operation.connection && current.connectionId === this.operation.connectionId);
  }
  context(expected) {
    const current = this.getContext();
    if (expected && (current.connection !== expected.connection || current.connectionId !== expected.connectionId)) throw failure('SESSION_CHANGED');
    if (!current.connection || current.exiting) throw failure('NOT_CONNECTED');
    return current;
  }
  async request(expected, patch) {
    this.context(expected);
    const mutation = patch !== undefined;
    try {
      const headers = {Accept: 'application/json'};
      if (expected.connection.secret) headers['X-Relay-Secret'] = expected.connection.secret;
      if (mutation) headers['Content-Type'] = 'application/json';
      const response = await this.fetchImpl(endpoint(expected.connection, '/api/llm/config'), {
        method: mutation ? 'PATCH' : 'GET', headers, ...(mutation ? {body: JSON.stringify(patch)} : {}),
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      this.context(expected);
      if (response.status === 401 || response.status === 403) throw failure('AUTH_REQUIRED');
      const value = await responseJson(response);
      this.context(expected);
      if (mutation && value?.needs_key === true) throw failure('NEEDS_KEY');
      if (mutation && value?.rolled_back === true) throw failure('ROLLED_BACK');
      if (!response.ok || !record(value) || value.ok === false) throw failure(mutation ? 'RESULT_UNKNOWN' : 'INVALID_RESPONSE');
      if (mutation && value.ok !== true) throw failure('RESULT_UNKNOWN');
      return value;
    } catch (error) {
      this.context(expected);
      if (Object.hasOwn(MESSAGES, error?.code)) {
        if (mutation && ['INVALID_RESPONSE', 'NETWORK_ERROR'].includes(error.code)) throw failure('RESULT_UNKNOWN');
        throw failure(error.code);
      }
      throw failure(mutation ? 'RESULT_UNKNOWN' : 'NETWORK_ERROR');
    }
  }
  remember(value, expected) {
    this.context(expected);
    const result = modelConfigDto(value, expected.connectionId);
    this.snapshot = {connection: expected.connection, connectionId: expected.connectionId, baseUrl: result.config.baseUrl};
    return result;
  }
  async get() {
    if (this.busy) throw failure('BUSY');
    const expected = this.context(), revision = this.revision;
    const value = await this.request(expected);
    if (revision !== this.revision) throw failure('BUSY');
    return this.remember(value, expected);
  }
  async save(value) {
    const patch = validateModelPatch(value);
    const expected = this.context();
    if (value.connectionId !== expected.connectionId) throw failure('SESSION_CHANGED');
    if (this.busy) throw failure('BUSY');
    // A displayed address is redacted. Omit an unchanged address so saving a
    // model does not replace private URL credentials or query parameters.
    if (this.snapshot?.connection === expected.connection && this.snapshot.connectionId === expected.connectionId
        && patch.base_url === this.snapshot.baseUrl) delete patch.base_url;
    const operation = expected;
    this.operation = operation;
    this.revision++;
    try {
      await this.request(expected, patch);
      let current;
      try { current = this.remember(await this.request(expected), expected); }
      catch (error) { if (error.code === 'SESSION_CHANGED') throw error; throw failure('RESULT_UNKNOWN'); }
      const normalizeUrl = url => url.replace(/\/+$/, '');
      if (current.config.model !== patch.model || current.config.provider !== patch.provider
          || (patch.base_url && normalizeUrl(current.config.baseUrl) !== normalizeUrl(publicModelUrl(patch.base_url)))
          || (patch.api_key && current.config.hasApiKey !== true)) throw failure('RESULT_UNKNOWN');
      return current;
    } finally { if (this.operation === operation) this.operation = null; }
  }
}

module.exports = {ModelConfig, modelConfigDto, validateModelPatch};
