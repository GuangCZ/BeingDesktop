'use strict';

window.BeingFeatureTasks = (() => {
  const featureNames = {bonfire: '篝火', fireside: '围炉', scroll: '卷轴', grove: '工具市场', portal: '电脑连接', channel: '消息渠道', model: '模型', workspace: '工作区', beings: '居民名录'};
  const statusNames = {running: '进行中', waiting: '等待中', succeeded: '已完成', failed: '未完成', cancelled: '已结束跟踪', needs_input: '需要你决定'};
  const activeStatuses = new Set(['running', 'waiting', 'needs_input']);
  const canEnd = task => task && (['waiting', 'needs_input'].includes(task.status) || task.status === 'running' && task.requestId && task.execution === 'being' && ['bonfire', 'fireside', 'scroll'].includes(task.feature));
  const clean = value => typeof value === 'string' ? value : '';
  const message = error => clean(error?.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 400) || '暂时无法读取任务，请重试。';
  const node = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };
  const button = (label, action, className = '') => {
    const element = node('button', `ft-button ${className}`, label);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  };
  const time = value => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
  };
  const validTasks = value => (Array.isArray(value) ? value : []).filter(task => task && typeof task === 'object' && clean(task.id));

  function mount(container, options = {}) {
    if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('A feature task container is required.');
    const {bridge, onNavigate, onDraft} = options;
    const state = {tasks: [], feature: clean(options.feature), filter: 'all', selected: '', loading: true, error: '', persistenceError: false, draftError: '', drafting: '', draftReady: '', ending: '', trackingError: null, destroyed: false, sequence: 0};
    const fixedFeature = Boolean(state.feature);
    const root = node('section', 'feature-tasks');
    root.setAttribute('aria-label', '功能任务');
    const header = node('header', 'ft-header');
    const heading = node('div');
    heading.append(node('h2', '', '功能任务'), node('p', 'ft-subtitle', '读取、检查和安装的进展与结果，都留在这里。'));
    const refreshButton = button('刷新列表', () => { void refresh(); }, 'ft-quiet');
    refreshButton.title = '读取本机已有任务，不向 Being 发送消息';
    header.append(heading, refreshButton);
    const filters = node('div', 'ft-filters');
    const featureLabel = node('label', 'ft-filter-label');
    featureLabel.append(node('span', '', '功能'));
    const featureSelect = node('select', 'ft-select');
    featureSelect.setAttribute('aria-label', '按功能筛选');
    featureLabel.append(featureSelect);
    featureLabel.hidden = fixedFeature;
    const statusLabel = node('label', 'ft-filter-label');
    statusLabel.append(node('span', '', '状态'));
    const statusSelect = node('select', 'ft-select');
    statusSelect.setAttribute('aria-label', '按状态筛选');
    for (const [value, label] of [['all', '全部状态'], ['active', '进行与等待'], ['needs_input', '需要你决定'], ['succeeded', '已完成'], ['failed', '未完成'], ['cancelled', '已结束跟踪']]) {
      const option = node('option', '', label); option.value = value; statusSelect.append(option);
    }
    statusLabel.append(statusSelect);
    const count = node('span', 'ft-count');
    filters.append(featureLabel, statusLabel, count);
    const notice = node('div', 'ft-notice');
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    const content = node('div', 'ft-content');
    const list = node('div', 'ft-list');
    list.setAttribute('aria-label', '任务列表');
    const detail = node('section', 'ft-detail');
    detail.setAttribute('aria-label', '任务详情');
    const empty = node('div', 'ft-empty');
    const emptyTitle = node('h3');
    const emptyCopy = node('p');
    empty.append(emptyTitle, emptyCopy);
    content.append(list, detail, empty);
    root.append(header, filters, notice, content);
    container.replaceChildren(root);
    let unsubscribe = null;

    const visibleTasks = () => state.tasks.filter(task => (!state.feature || task.feature === state.feature) && (state.filter === 'all' || (state.filter === 'active' ? activeStatuses.has(task.status) : task.status === state.filter)));

    function renderFeatures() {
      const names = new Map(Object.entries(featureNames));
      for (const task of state.tasks) if (clean(task.feature) && !names.has(task.feature)) names.set(task.feature, task.feature);
      if (state.feature && !names.has(state.feature)) names.set(state.feature, state.feature);
      const entries = [['', '全部功能'], ...names];
      if (JSON.stringify(entries) === featureSelect.dataset.options) return;
      featureSelect.dataset.options = JSON.stringify(entries);
      featureSelect.replaceChildren(...entries.map(([value, label]) => {const option = node('option', '', label); option.value = value; return option;}));
      featureSelect.value = state.feature;
    }

    function renderDetail(task) {
      detail.replaceChildren();
      detail.hidden = !task;
      if (!task) return;
      const top = node('div', 'ft-detail-heading');
      const identity = node('div');
      identity.append(node('p', 'ft-eyebrow', featureNames[task.feature] || clean(task.feature) || '功能任务'), node('h3', '', clean(task.title) || '功能任务'));
      const status = node('span', `ft-status ft-status-${statusNames[task.status] ? task.status : 'waiting'}`, statusNames[task.status] || '状态待确认');
      top.append(identity, status);
      detail.append(top);
      const usesBeing = task.execution === 'being' || task.mayDelayChat === true;
      const execution = usesBeing ? '使用 Being，聊天可能等待' : task.execution === 'local' || task.execution === 'native' ? '本机执行' : '执行方式待确认';
      detail.append(node('p', `ft-execution${usesBeing ? ' ft-execution-being' : ''}`, execution));
      const result = node('div', 'ft-result');
      const summary = clean(task.summary);
      const taskDetail = clean(task.detail);
      const resultHeading = task.status === 'needs_input' ? '需要你决定' : task.status === 'failed' ? '未完成的原因' : task.status === 'succeeded' ? '结果' : '当前进展';
      result.append(node('h4', '', resultHeading));
      result.append(node('p', task.status === 'failed' ? 'ft-error' : '', summary || taskDetail || (task.status === 'waiting' ? '结果尚未确认；不会自动重新提交。' : task.status === 'running' ? '正在处理，结果会更新在这里。' : task.status === 'cancelled' ? '已结束本地跟踪，Being 端执行状态需另行确认。' : '暂时没有更多详情。')));
      if (summary && taskDetail && summary !== taskDetail) result.append(node('p', 'ft-result-detail', taskDetail));
      detail.append(result);
      const meta = node('dl', 'ft-metadata');
      for (const [label, value] of [['创建', time(task.createdAt)], ['更新', time(task.updatedAt)], ['结束', time(task.finishedAt)]]) {
        if (value) {meta.append(node('dt', '', label), node('dd', '', value));}
      }
      detail.append(meta);
      const actions = node('div', 'ft-detail-actions');
      if (typeof onNavigate === 'function' && clean(task.feature)) {
        const go = button(task.status === 'needs_input' ? '到功能页处理' : '打开功能页', () => onNavigate(task.feature, task), task.status === 'needs_input' ? 'ft-primary' : 'ft-secondary');
        go.dataset.action = 'navigate';
        actions.append(go);
      }
      if (typeof bridge?.discussFeatureTask === 'function' && typeof onDraft === 'function') {
        const discuss = button(state.drafting === task.id ? '正在准备…' : '拿到聊天里讨论', () => { void discussTask(task.id); }, 'ft-secondary');
        discuss.dataset.action = 'discuss';
        discuss.disabled = Boolean(state.drafting) || (!summary && !taskDetail);
        discuss.title = '把相关结果放入聊天输入框，编辑后由你发送';
        actions.append(discuss);
      }
      detail.append(actions);
      const draftHint = node('p', 'ft-draft-hint', '只有你选择讨论，才会把相关结果放入聊天草稿。');
      if (state.draftReady === task.id) draftHint.textContent = '已放入聊天草稿，编辑后由你发送。';
      if (state.draftError && state.selected === task.id) {draftHint.textContent = state.draftError; draftHint.classList.add('ft-error');}
      detail.append(draftHint);
      if (typeof bridge?.endFeatureTaskTracking === 'function' && canEnd(task)) {
        const tracking = node('div', 'ft-tracking');
        const end = button(state.ending === task.id ? '正在结束…' : '结束本地跟踪', () => { void endTracking(task.id); }, 'ft-quiet');
        end.dataset.action = 'end-tracking';
        end.disabled = Boolean(state.ending);
        tracking.append(end, node('p', 'ft-tracking-hint', '停止本地结果检查并关闭记录，Being 端执行不会取消。'));
        if (state.trackingError?.id === task.id) {
          const error = node('p', 'ft-tracking-hint ft-error', state.trackingError.message);
          error.setAttribute('role', 'status');
          tracking.append(error);
        }
        detail.append(tracking);
      }
    }

    function render() {
      if (state.destroyed) return;
      const focusedTaskId = document.activeElement?.closest('.ft-task')?.dataset.taskId;
      const oldScrollTop = list.scrollTop;
      renderFeatures();
      featureSelect.value = state.feature;
      statusSelect.value = state.filter;
      refreshButton.disabled = state.loading || typeof bridge?.getFeatureTasks !== 'function';
      refreshButton.textContent = state.loading ? '读取中…' : '刷新列表';
      root.setAttribute('aria-busy', String(state.loading));
      notice.textContent = [state.error, state.persistenceError ? '任务记录暂未保存，重启后可能无法恢复。当前操作不受影响。' : ''].filter(Boolean).join('\n');
      notice.classList.toggle('ft-persistence-warning', state.persistenceError && !state.error);
      notice.hidden = !notice.textContent;
      const tasks = visibleTasks();
      if (!tasks.some(task => task.id === state.selected)) state.selected = tasks[0]?.id || '';
      count.textContent = `${tasks.length} 个任务`;
      list.replaceChildren();
      for (const task of tasks) {
        const item = button('', () => {state.selected = task.id; state.draftError = ''; render();}, 'ft-task');
        item.dataset.taskId = task.id;
        item.classList.toggle('is-selected', task.id === state.selected);
        item.setAttribute('aria-pressed', String(task.id === state.selected));
        const top = node('span', 'ft-task-top');
        top.append(node('strong', 'ft-task-title', clean(task.title) || '功能任务'), node('span', `ft-task-dot ft-dot-${statusNames[task.status] ? task.status : 'waiting'}`));
        const bottom = node('span', 'ft-task-bottom');
        bottom.append(node('span', '', `${featureNames[task.feature] || clean(task.feature) || '功能'} · ${statusNames[task.status] || '状态待确认'}`), node('time', '', time(task.updatedAt || task.createdAt)));
        item.append(top, bottom);
        list.append(item);
      }
      list.hidden = !tasks.length;
      list.scrollTop = oldScrollTop;
      if (focusedTaskId) Array.from(list.children).find(item => item.dataset.taskId === focusedTaskId)?.focus({preventScroll: true});
      renderDetail(tasks.find(task => task.id === state.selected));
      empty.hidden = Boolean(tasks.length);
      emptyTitle.textContent = state.loading ? '正在读取任务…' : state.error ? '任务暂时无法读取' : state.tasks.length ? '没有符合筛选的任务' : '还没有功能任务';
      emptyCopy.textContent = state.error ? '可以重试刷新列表。已经提交的操作不会因此重发。' : state.tasks.length ? '换一个功能或状态查看。' : '在功能页开始读取、检查或安装后，可在这里查看进展与结果。';
    }

    async function refresh() {
      if (state.destroyed || (state.loading && state.sequence > 0)) return;
      if (typeof bridge?.getFeatureTasks !== 'function') {state.loading = false; state.error = '当前版本尚未提供功能任务记录。'; render(); return;}
      const sequence = ++state.sequence;
      state.loading = true;
      state.error = '';
      render();
      try {
        const response = await bridge.getFeatureTasks({});
        if (state.destroyed || sequence !== state.sequence) return;
        state.tasks = validTasks(response?.tasks);
        state.persistenceError = response?.persistenceError === true;
      } catch (error) {
        if (!state.destroyed && sequence === state.sequence) state.error = message(error);
      } finally {
        if (!state.destroyed && sequence === state.sequence) {state.loading = false; render();}
      }
    }

    async function discussTask(id) {
      if (state.destroyed || state.drafting || typeof onDraft !== 'function') return;
      const task = state.tasks.find(item => item.id === id);
      if (!task || (!clean(task.summary) && !clean(task.detail))) return;
      state.drafting = id;
      state.draftError = '';
      render();
      try {
        const draft = await bridge.discussFeatureTask(id);
        if (state.destroyed || !state.tasks.some(item => item.id === id)) return;
        if (draft?.prepared !== true || draft.taskId !== id) throw new Error('草稿尚未准备完成，请重试。');
        await onDraft(draft, task);
        if (!state.destroyed) state.draftReady = id;
      } catch (error) {
        if (!state.destroyed && state.selected === id) state.draftError = message(error);
      } finally {
        if (!state.destroyed) {state.drafting = ''; render();}
      }
    }

    async function endTracking(id) {
      if (state.destroyed || state.ending || typeof bridge?.endFeatureTaskTracking !== 'function') return;
      const task = state.tasks.find(item => item.id === id);
      if (!canEnd(task)) return;
      state.ending = id;
      state.trackingError = null;
      render();
      try {
        await bridge.endFeatureTaskTracking(id);
      } catch (error) {
        if (!state.destroyed) state.trackingError = {id, message: message(error)};
      } finally {
        if (!state.destroyed) {state.ending = ''; render();}
      }
    }

    featureSelect.addEventListener('change', () => {state.feature = featureSelect.value; state.draftError = ''; render();});
    statusSelect.addEventListener('change', () => {state.filter = statusSelect.value; state.draftError = ''; render();});
    if (typeof bridge?.onFeatureTasks === 'function') {
      unsubscribe = bridge.onFeatureTasks(snapshot => {
        if (state.destroyed || !Array.isArray(snapshot?.tasks)) return;
        state.sequence++;
        state.tasks = validTasks(snapshot.tasks);
        state.persistenceError = snapshot.persistenceError === true;
        state.loading = false;
        render();
      });
    }
    render();
    void refresh();
    return {
      refresh,
      setFeature(feature = '') {state.feature = clean(feature); state.filter = 'all'; render();},
      select(id) {const task = state.tasks.find(item => item.id === id); if (task) {state.feature = fixedFeature ? state.feature : ''; state.filter = 'all'; state.selected = id; render();}},
      destroy() {if (state.destroyed) return; state.destroyed = true; state.sequence++; if (typeof unsubscribe === 'function') unsubscribe(); container.replaceChildren();},
    };
  }

  return {mount};
})();
