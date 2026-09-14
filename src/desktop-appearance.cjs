'use strict';

// Electron's native vibrancy supplies the desktop material. The renderer adds
// a restrained frosted frame; content remains a separate reading surface.
function windowAppearance({platform = process.platform, background, reducedTransparency = false, highContrast = false} = {}) {
  if (platform !== 'darwin') return {frame: false, backgroundColor: background};
  const opaque = reducedTransparency || highContrast;
  return {
    frame: true,
    titleBarStyle: 'hidden',
    trafficLightPosition: {x: 20, y: 21},
    backgroundColor: opaque ? background : '#00000000',
    vibrancy: opaque ? undefined : 'under-window',
    visualEffectState: 'followWindow',
  };
}

function systemAppearance(nativeTheme) {
  return {
    reducedTransparency: nativeTheme.prefersReducedTransparency === true,
    highContrast: nativeTheme.shouldUseHighContrastColors === true,
  };
}

function applyWindowAppearance(win, nativeTheme, background, platform = process.platform) {
  const options = windowAppearance({platform, background, ...systemAppearance(nativeTheme)});
  win.setBackgroundColor(options.backgroundColor);
  if (platform === 'darwin') win.setVibrancy(options.vibrancy || null);
}

module.exports = {windowAppearance, systemAppearance, applyWindowAppearance};
