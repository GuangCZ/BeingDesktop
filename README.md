# Being Desktop

A Windows desktop home for your existing Being: Loom conversations, local files, browser, PowerShell, Grove tools, and Heart Portal.

[中文](README_CN.md) · [Documentation](https://GuangCZ.github.io/BeingDesktop/) · [Downloads](https://github.com/GuangCZ/BeingDesktop/releases)

## Features

- Multiple conversations, image input, tool selection, and message navigation.
- Workspace browser, embedded web browser, and persistent PowerShell tabs.
- Local Portal setup, process status, permissions, and update notifications.
- Grove discovery, environment checks, and supported Kit installation.
- Town and Channel entry points, subject to the connected service's capabilities.
- Settings for appearance, reading, Loom connections, and model configuration.

Version **0.8.19**, Windows x64. Requires an existing Being and Loom connection. The desktop does not host or migrate your Being's identity and memory.

## Develop

Use Windows x64 with Node.js 24 and npm:

```powershell
npm ci
npm start
```

```powershell
npm run check
npm test
npm run pack
```

`npm run pack` creates `dist/win-unpacked`. Keep the complete directory together. `npm run dist` builds the portable executable. If the native terminal module reports an ABI mismatch, rebuild `node-pty` for the configured Electron version.

`npm start` uses the app's default user data directory. `Start.ps1` uses `.local/profile` in the checkout. Do not commit profiles, credentials, or build artifacts.

## Documentation

Edit `docs/content_CN.json`, then run:

```powershell
node scripts/build-docs.cjs
node scripts/check-docs.cjs
```

GitHub Pages serves `main:/docs`. The site has static pages, local search, responsive navigation, and light/dark themes with no external runtime dependencies.

## License

MIT. Third-party assets and dependencies retain their respective licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). [BeingAnywhere](https://github.com/GuangCZ/BeingAnywhere) is the related browser extension.
