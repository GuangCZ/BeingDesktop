'use strict';

(() => {
  const bridge = window.beingDesktop;
  const $ = id => document.getElementById(id);
  const customValue = '__custom__';
  let identity = '';
  let connected = false;
  let active = false;
  let generation = 0;
  let busy = '';
  let attempted = false;
  let snapshot = null;
  let models = [];
  let providers = [];
  let feedback = '';
  let failed = false;

  const cleanError = error => String(error?.message || '操作未完成，请重试。')
    .replace(/^Error invoking remote method 'being:[A-Za-z]+': (?:Error: )?/, '');
  const modelOptionValue = index => `model-${index}`;
  const selectedModel = () => models.find((_model, index) => modelOptionValue(index) === $('model-select').value);
  const modelName = () => $('model-select').value === customValue ? $('model-custom-name').value.trim() : selectedModel()?.id || '';
  const draft = () => ({ model: modelName(), provider: $('model-provider').value, baseUrl: $('model-base-url').value.trim() });
  const isDirty = () => snapshot && (Object.entries(draft()).some(([key, value]) => value !== (snapshot.config[key] || '')) || Boolean($('model-api-key').value));

  function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  function renderControls() {
    const editable = connected && Boolean(snapshot) && !busy;
    for (const id of ['model-select', 'model-provider', 'model-base-url', 'model-api-key']) $(id).disabled = !editable;
    const custom = $('model-select').value === customValue;
    $('model-custom-field').hidden = !custom;
    $('model-custom-name').disabled = !editable || !custom;
    $('model-custom-name').required = custom;
    $('model-config-refresh').disabled = !connected || Boolean(busy);
    $('model-config-save').disabled = !editable || !isDirty() || !modelName() || !$('model-provider').value;
    $('model-config-save').textContent = busy === 'save' ? '正在保存…' : '保存模型配置';
    $('model-settings').setAttribute('aria-busy', String(Boolean(busy)));
    $('model-config-status').textContent = !connected ? '连接 Being 后即可配置模型。'
      : busy === 'load' ? '正在读取配置与支持的模型…'
      : busy === 'save' ? '正在保存并确认模型配置…'
      : feedback || (isDirty() ? '有未保存的更改，保存后应用到当前 Being。' : '配置保存在当前 Being，选择后点击保存。');
    $('model-config-status').classList.toggle('tone-error', failed && !busy && connected);
  }

  function fillForm(value, preserveDraft = false) {
    const previous = preserveDraft ? { ...draft(), custom: $('model-select').value === customValue, apiKey: $('model-api-key').value } : null;
    snapshot = value;
    models = Array.isArray(value.models) ? value.models : [];
    providers = Array.isArray(value.providers) ? value.providers.slice() : [];
    for (const model of [value.config, ...models, ...(previous ? [previous] : [])]) {
      if (model.provider && !providers.some(provider => provider.id === model.provider)) {
        providers.push({ id: model.provider, name: model.provider, baseUrl: model.baseUrl || '' });
      }
    }
    const values = previous || value.config;
    $('model-provider').replaceChildren(...providers.map(provider => option(provider.id, provider.name || provider.id)));
    $('model-provider').value = values.provider || '';
    $('model-base-url').value = values.baseUrl || '';
    $('model-api-key').value = previous?.apiKey || '';
    $('model-custom-name').value = values.model || '';
    $('model-select').replaceChildren(...models.map((model, index) => option(modelOptionValue(index), `${model.name || model.id}${model.name && model.name !== model.id ? ` · ${model.id}` : ''} · ${model.provider}`)), option(customValue, '自定义模型…'));
    const match = models.findIndex(model => model.id === values.model && model.provider === values.provider);
    $('model-select').value = !previous?.custom && match >= 0 ? modelOptionValue(match) : customValue;
    $('model-list-status').textContent = value.modelsError || (models.length ? `${models.length} 个支持的模型，也可填写自定义模型 ID。` : '当前 Being 未提供模型列表，可填写自定义模型 ID。');
    $('model-list-status').classList.toggle('tone-error', Boolean(value.modelsError));
    $('model-key-note').textContent = value.config.hasApiKey ? '已有密钥；留空保留，填写新密钥可替换。' : '当前配置未提供密钥；按服务要求填写。';
    renderControls();
  }

  async function load() {
    if (!connected || busy) return;
    const request = generation;
    const preserveDraft = Boolean(isDirty());
    attempted = true;
    busy = 'load';
    feedback = '';
    failed = false;
    renderControls();
    try {
      if (!bridge?.getModelConfig) throw new Error('桌面连接尚未就绪，请使用 Being Desktop 应用打开此页面。');
      const value = await bridge.getModelConfig();
      if (request !== generation) return;
      if (!value?.config || typeof value.config.model !== 'string' || typeof value.config.provider !== 'string') throw new Error('模型配置读取失败，请重试。');
      fillForm(value, preserveDraft);
      if (preserveDraft) feedback = '已刷新支持的模型，保留了未保存的更改。';
    } catch (error) {
      if (request !== generation) return;
      feedback = cleanError(error);
      failed = true;
    } finally {
      if (request === generation) { busy = ''; renderControls(); }
    }
  }

  async function save(event) {
    event.preventDefault();
    if ($('model-config-save').disabled || !$('model-config-form').reportValidity()) return;
    const request = generation;
    const payload = { ...draft(), connectionId: snapshot.connectionId };
    if ($('model-api-key').value.trim()) payload.apiKey = $('model-api-key').value.trim();
    busy = 'save';
    feedback = '';
    failed = false;
    renderControls();
    try {
      const value = await bridge.saveModelConfig(payload);
      if (request !== generation) return;
      if (!value?.config) throw new Error('保存结果尚未确认，请刷新配置后检查。');
      fillForm(value);
      feedback = '模型配置已保存，并已从 Being 读回确认。';
    } catch (error) {
      if (request !== generation) return;
      feedback = cleanError(error);
      failed = true;
    } finally {
      delete payload.apiKey;
      if (request === generation) { busy = ''; renderControls(); }
    }
  }

  function changed() { feedback = ''; failed = false; renderControls(); }

  $('model-select').addEventListener('change', () => {
    const model = selectedModel();
    if (model) {
      const providerChanged = model.provider !== $('model-provider').value;
      const endpoint = model.baseUrl || (providerChanged ? providers.find(provider => provider.id === model.provider)?.baseUrl : '');
      if (model.provider !== $('model-provider').value || (endpoint && endpoint !== $('model-base-url').value)) $('model-service-settings').open = true;
      $('model-provider').value = model.provider;
      if (endpoint || providerChanged) $('model-base-url').value = endpoint || '';
    }
    changed();
    if ($('model-select').value === customValue) $('model-custom-name').focus();
  });
  $('model-provider').addEventListener('change', () => {
    const name = modelName();
    const provider = providers.find(item => item.id === $('model-provider').value);
    $('model-base-url').value = provider?.baseUrl || '';
    if (selectedModel()?.provider !== $('model-provider').value) {
      $('model-select').value = customValue;
      $('model-custom-name').value = name;
    }
    changed();
  });
  for (const id of ['model-custom-name', 'model-base-url', 'model-api-key']) $(id).addEventListener('input', changed);
  $('model-config-refresh').addEventListener('click', () => { void load(); });
  $('model-config-form').addEventListener('submit', event => { void save(event); });

  window.beingModelSettings = Object.freeze({
    setState(state) {
      const ready = state.connection?.configured === true && state.connection?.status === 'connected';
      const nextIdentity = JSON.stringify([ready, state.connection?.beingName, state.connection?.displayUrl, state.townApp?.identity?.identityRevision, state.townApp?.identity?.connectionRevision]);
      connected = ready;
      if (identity !== nextIdentity) {
        identity = nextIdentity;
        generation += 1;
        busy = '';
        snapshot = null;
        models = [];
        providers = [];
        attempted = false;
        feedback = '';
        failed = false;
        $('model-config-form').reset();
        $('model-select').replaceChildren(option('', connected ? '待读取模型列表' : '连接 Being 后读取模型'));
        $('model-provider').replaceChildren();
        $('model-service-settings').open = false;
        $('model-list-status').textContent = '模型列表由当前 Being 提供。';
        $('model-list-status').classList.remove('tone-error');
        $('model-key-note').textContent = '留空保留已有密钥；填写后随模型配置保存。';
      }
      renderControls();
      if (active && connected && !attempted) void load();
    },
    activate() { active = true; if (connected && !attempted) void load(); },
  });
})();
