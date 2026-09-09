# Being Desktop

A Windows and macOS desktop home for your existing Being: Loom conversations, local files, browser, PowerShell, Grove tools, and Heart Portal.

[中文](README_CN.md) · [Documentation](https://GuangCZ.github.io/BeingDesktop/) · [Downloads](https://github.com/GuangCZ/BeingDesktop/releases)

## Features

- Multiple conversations, image input, tool selection, and message navigation.
- Workspace browser, embedded web browser, and persistent PowerShell tabs.
- Local Portal setup, process status, permissions, and update notifications.
- Grove discovery, environment checks, and supported Kit installation.
- Town and Channel entry points, subject to the connected service's capabilities.
- Settings for appearance, reading, Loom connections, and model configuration.
- Orchestrator mode: Being plans and evaluates; Codex, Cursor or Grok Build CLI workers execute, report progress beneath their conversation, and return results to that conversation.

Current source version **0.8.22**, Windows x64. Download availability follows GitHub Releases. Requires an existing Being and Loom connection. The desktop does not host or migrate your Being's identity and memory.

## Orchestrator mode

Choose a local workspace, install and authenticate a supported CLI, then enable **Settings → 编排模式**. Desktop detects the Agent Kit and connects its own Worker tool bridge. Unavailable workers never fall back to local direct execution.

Every Desktop profile has a persistent ID. Sessions, tasks and result routing belong to the originating Desktop; local direct/orchestrator modes can differ while connecting to the same Being. CLI workers use that Desktop's local authentication, endpoint, proxy and workspace. Switching modes does not modify Being's shared model endpoint. Identity, memory and the remote runtime remain shared; Desktop IDs are not server-side context or security isolation.

For upgrades from the old shared gateway mode, confirm the ordinary endpoint in Model settings if `/orchestrator/v1` still prevents direct execution. The app will not silently rewrite this shared setting.

Read the [user guide](docs/orchestration.html) for setup and recovery, or the [implementation notes](docs/orchestration.md) for Desktop identity, callback lifecycle and isolation limits.

## Develop

Use Windows x64 or macOS with Node.js 24 and npm:

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

`npm start` uses the app's default user data directory. `Start.ps1` uses the same default user data directory. Do not commit profiles, credentials, or build artifacts.

## Build a macOS preview

On a Mac, install Node.js 24, npm, Python 3, and Xcode Command Line Tools
(`xcode-select --install`). Use a fresh checkout or run `npm ci` on the Mac;
do not copy Windows `node_modules` or build outputs.

```sh
npm ci
npm run check
npm run pack:mac
npm run dist:mac
```

`pack:mac` produces an `.app`; `dist:mac` produces DMG and ZIP files in
`dist/macos`. Both default to the architecture of the running Node.js process.
Use `npm run dist:mac:arm64` for Apple Silicon or `npm run dist:mac:x64` for
Intel. Build and test each architecture on a matching Mac where possible;
these are separate packages, not a universal binary. You can also use
`npm run pack:mac -- --arm64` or `--x64` for an explicit directory build.

The macOS configuration rebuilds native dependencies for Electron. Test packages
use the persistent local signing certificate in Keychain; a missing certificate
stops the build. These DMGs are not Apple-notarized, so recipients may see a
Gatekeeper warning and upgrades may require Keychain approval. Optional
`BEING_SIGNING_MODE=developer-id` packaging uses a pinned Apple Developer ID team.
See [macOS signing details](docs/macos.md#stable-signing-and-keychain-access).

## Documentation

Edit `docs/content_CN.json`, then run:

```powershell
node scripts/build-docs.cjs
node scripts/check-docs.cjs
```

GitHub Pages serves the root of `gh-pages`; documentation sources and generated pages are maintained in `main:/docs`. After committing changes, run `node scripts/publish-docs.cjs` from the independent repository to publish them. The site has static pages, local search, responsive navigation, and light/dark themes with no external runtime dependencies.

## License

MIT. Third-party assets and dependencies retain their respective licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). [BeingAnywhere](https://github.com/GuangCZ/BeingAnywhere) is the related browser extension.

## macOS integration

This branch (`0.8.22-mac.7`) supports the official arm64/x86_64 Heart Portal binaries, architecture-specific hash verification, existing-process detection, zsh terminals and console jobs, Command shortcuts, and Homebrew runtime discovery when launched from Finder. External Portal services retain ownership of their own process and configuration. Reviewed Grove recipes remain pinned to verified package versions and hashes.

Run `npm run test:mac` on a Mac, and `npm run dist:mac:arm64` to build an Apple Silicon DMG and ZIP. Test packages use a persistent local signing certificate without Apple notarization. See [macOS details](docs/macos.md) for validation and boundaries.
