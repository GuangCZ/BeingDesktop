'use strict';

const steps = new Set(['loom', 'review', 'portal', 'channel', 'grove', 'town', 'bonfire', 'complete']);

function onboardingState(step) {
  return {step, completed: step === 'complete'};
}

function restoreOnboarding(settings = {}, {configured: connectionConfigured} = {}) {
  const saved = settings.onboarding;
  if (saved && typeof saved === 'object' && !Array.isArray(saved) && steps.has(saved.step)) {
    if (saved.step !== 'complete' && connectionConfigured === false) return onboardingState('loom');
    return onboardingState(saved.step);
  }
  // Profiles configured before onboarding was introduced should remain undisturbed.
  const configured = ['credential', 'workspace', 'portalExecutable', 'portalConfig']
    .some(key => typeof settings[key] === 'string' && settings[key].trim().length > 0)
    || Boolean(settings.managedPortal && typeof settings.managedPortal === 'object');
  return onboardingState(configured ? 'complete' : 'loom');
}

function validateOnboardingStep(step, configured) {
  if (!steps.has(step)) throw new Error('无效的新手引导步骤。');
  if (step !== 'loom' && configured !== true) throw new Error('请先配置 Loom 连接。');
  return onboardingState(step);
}

async function saveOnboardingStep(step, {settings, configured, persist}) {
  const next = validateOnboardingStep(step, configured);
  const previous = settings.onboarding;
  settings.onboarding = next;
  try { await persist(); }
  catch {
    if (previous === undefined) delete settings.onboarding;
    else settings.onboarding = previous;
    throw new Error('新手引导进度未能保存，请重试。');
  }
  return next;
}

async function completeOnboardingAfterBonfire(receipt, {settings, configured, persist, isCurrent}) {
  if (receipt?.ok !== true || typeof receipt.id !== 'string' || !/^(0|[1-9]\d*)$/.test(receipt.id)
    || !Number.isSafeInteger(Number(receipt.id)) || !Array.isArray(receipt.mentions)
    || settings.onboarding?.step !== 'bonfire' || configured !== true || !isCurrent()) return receipt;
  try {
    const onboarding = await saveOnboardingStep('complete', {settings, configured, persist});
    return {...receipt, onboarding};
  } catch {
    // A storage error must never turn an acknowledged send into a retryable send failure.
    return {...receipt, onboardingError: '消息已发送，但新手引导进度未能保存。请重试保存进度，无需再次发送。'};
  }
}

module.exports = {restoreOnboarding, validateOnboardingStep, saveOnboardingStep, completeOnboardingAfterBonfire};
