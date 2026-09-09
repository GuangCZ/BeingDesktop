# macOS Liquid Glass styling

The macOS shell now uses native window controls, a unified toolbar, translucent
navigation, rounded content panels, glass selection highlights and glass sheets.
The implementation is scoped to `data-platform="darwin"`; Windows and Linux keep
their existing window chrome. Existing saved palettes remain intact, and the
light, dark and custom palettes continue to work through Settings → Appearance.

Electron provides the native `sidebar` vibrancy material, with
`visualEffectState: 'followWindow'`. CSS provides the Liquid Glass visual hierarchy,
edge highlights and rounded controls. This is **not an NSGlassEffectView bridge**
and does not reproduce Apple's optical refraction shader. It uses supported
Electron APIs without introducing a native addon or a macOS 26-only dependency.

The native File, Edit, View, Window and Help menus remain available. The titlebar
reserves space for native traffic lights and uses normal macOS drag behavior;
interactive controls explicitly disable dragging. Shortcut hints use ⌘.

Main content stays opaque for reading. The chat and browser WebContentsView
containers retain DOM-measured bounds and are never scaled or animated by the
glass stylesheet. On macOS, every mounted conversation also gets a native
17-point border radius via `WebContentsView.setBorderRadius`, including cached
sessions. Shell CSS alone cannot clip these separately composited views.
The browser, terminal, inspector, settings and onboarding
surfaces use the same spacing and corner hierarchy.

## Accessibility

- System Reduce Transparency disables native vibrancy and CSS blur, and makes
  navigation and sheets opaque. Changing a saved palette preserves that choice.
- Increase Contrast also removes translucency and outlines selected navigation.
- Reduce Motion disables transitions, scrolling animations and status pulses.
- Keyboard focus, disabled controls, sidebar collapse and settings scrolling
  remain available at the 1000 × 700 minimum window size.

## Validation

```sh
npm run check
npm test
npm run test:theme
./node_modules/.bin/electron test/macos-glass-electron.cjs
```

The glass integration check launches the production shell with a temporary,
account-free profile. It checks light/dark layouts at two sizes, sidebar and
inspector visibility, accessibility fallbacks, native window controls and the
actual browser WebContentsView bounds using a local HTTP fixture. It writes
screenshots and a report to `.local/glass-validation`. It does not connect a
Being account or claim to validate a live Loom conversation.

To build a separate local application without replacing the installed app:

```sh
./node_modules/.bin/electron-builder --config electron-builder.mac.cjs \
  --mac --dir --publish never --config.directories.output=.local/glass-build
```

## References

- [Apple: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple: Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
- [Electron: BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)

Implementation: `src/desktop-appearance.cjs`, `renderer/macos-glass.css`, and the
window state integration in `src/main.cjs` and `renderer/app.js`.
