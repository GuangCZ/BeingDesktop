'use strict';

window.featureTasksFixture = (() => {
  const state = {calls: [], drafts: [], navigation: [], listener: null, read: null, discussion: null, ending: null, subscriptions: 0};
  const bridge = {
    getFeatureTasks(filter) {state.calls.push({method: 'getFeatureTasks', filter}); return new Promise((resolve, reject) => {state.read = {resolve, reject};});},
    onFeatureTasks(listener) {state.listener = listener; state.subscriptions++; return () => {state.listener = null; state.subscriptions--;};},
    discussFeatureTask(id) {state.calls.push({method: 'discussFeatureTask', id}); return new Promise((resolve, reject) => {state.discussion = {resolve, reject};});},
    endFeatureTaskTracking(id) {state.calls.push({method: 'endFeatureTaskTracking', id}); return new Promise((resolve, reject) => {state.ending = {resolve, reject};});},
  };
  let controller;
  const mount = (options = {}) => {
    controller?.destroy();
    controller = window.BeingFeatureTasks.mount(document.getElementById('tasks'), {
      bridge, onNavigate: (feature, task) => {state.navigation.push({feature, id: task.id});},
      onDraft: (draft, task) => {state.drafts.push({draft, id: task.id});}, ...options,
    });
    return controller;
  };
  mount();
  return {state, mount, get controller() {return controller;}};
})();
