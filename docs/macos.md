# macOS integration

This local build is version `0.8.22-mac.5`. Build with Node.js 24 and run:

```sh
npm ci
npm run check
npm test
npm run test:mac
npm run dist:mac:arm64
# On an Intel Mac, use npm run dist:mac:x64 instead.
```

Artifacts are written to `dist/macos`. The macOS configuration rebuilds native
dependencies for Electron and keeps node-pty outside ASAR.

## Stable signing and Keychain access

The default build uses the persistent local certificate and private key already
stored in the login Keychain. Its public metadata and certificate live in
`~/Library/Application Support/Being Desktop Signing/`. Signing fails if this
identity is missing; the build never recreates it or falls back to ad-hoc signing.
This mode is intended for the owner's testing and DMG sharing with testers.

A recipient with no existing Being Safe Storage item does not have an older
application's Keychain ACL to migrate. First-use creation and subsequent access
by the same binary are tested separately from upgrades. An isolated application
profile alone does not isolate the macOS Keychain, and testing on the build Mac
does not guarantee behavior on every recipient's Mac.

Optional Apple Developer ID builds require a certificate with its private key in
Keychain. After importing an existing identity, run:

```sh
node scripts/macos-signing.cjs select-developer
BEING_SIGNING_MODE=developer-id npm run dist:mac:arm64
```

If multiple identities are available, set `CSC_NAME` to the intended certificate's
SHA-1 fingerprint. Selection pins the Apple team and application ID
`town.beings.desktop` in
`~/Library/Application Support/Being Desktop Signing/developer-identity.json`.
Updates must use that team; certificate renewal within the same team is allowed.
The Developer ID mode fails if the identity is missing or ambiguous. After
signing, the hook verifies the complete bundle, Apple trust anchor, pinned team
and application ID, and rejects hash-specific requirements. Private signing
material must never be added to this repository.

The local self-signed certificate was tested with two differently compiled native
binaries, the same signing certificate and an identical designated requirement.
The first build created and read a synthetic Keychain item. The second build was
refused with `errSecAuthFailed` (`-25293`) while UI interaction was disabled.
Consequently, local self-signing is **not a verified fix for cross-update Keychain
prompts**. Apple Security's [partition implementation](https://github.com/Apple-FOSS-Mirror/Security/blob/master/securityd/src/clientid.cpp)
uses code hashes for signed code it cannot classify into a trusted signing team.

`BEING_SIGNING_MODE=local-test npm run dist:mac:arm64` retains a separate diagnostic
self-signing path. It requires the existing local certificate and private key;
it never creates a new identity automatically. These artifacts go into
`dist/macos/experimental-local-signing` and must not be presented as the Keychain
fix. These earlier experimental artifacts are retained as diagnostic evidence.

Moving from an older ad-hoc build to Developer ID can require a one-time approval
for the existing `Being Desktop Safe Storage` item. Enter the Keychain password
only in the macOS dialog. The signing workflow does not delete or export stored
credentials or change their access rules. Cross-build access must be retested
with the actual Developer ID before claiming the recurring prompt is fixed.

The default self-signed DMG is not Apple-notarized and macOS may display an
unverified-developer warning when downloaded. This is separate from Keychain
authorization. Apple notarization is currently disabled. Hardened runtime is also disabled to
preserve existing native-module behavior; public distribution needs a separate
notarization and hardened-runtime validation step. Stable signing alone does not
establish notarization or successful credential migration.

## Official Portal binaries

Portal already supports macOS. Desktop downloads the official version 0.8.0
binary for the host architecture, checks its exact byte length and SHA-256,
sets owner-only executable permissions, and moves it into place atomically.

| Architecture | Official release asset | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Apple Silicon | [heart-portal-macos-arm64](https://github.com/d5z/heart-portal/releases/download/v0.8.0/heart-portal-macos-arm64) | 12930864 | `eb3696c04bb3972832443311ffa84e00b50cca92ca35347fa955fb116e23074b` |
| Intel | [heart-portal-macos-x86_64](https://github.com/d5z/heart-portal/releases/download/v0.8.0/heart-portal-macos-x86_64) | 13560240 | `2c74efc68e2f24fc2849e122ea450ee90d51dba850b5a92c5c2409ed8c21e622` |

Process inspection reads PID and executable name using macOS `ps`; it never
reads command-line arguments. An existing Portal, including a separately managed
LaunchAgent, is shown as external. Onboarding offers to continue while preserving
that service. Desktop does not adopt its credentials, stop it, or claim its
connection is healthy. Inspection failures continue to block duplicate launches.
Desktop-managed Portal shutdown uses SIGINT.

The update checker selects releases containing the correct architecture asset.
It reports available updates; the managed installer remains pinned to the
reviewed release above.

## Terminal, console and tools

The interactive terminal uses native node-pty and `/bin/zsh -f -i`. Command jobs
use `/bin/zsh -f -s`, with commands delivered over stdin. User startup files are
not automatically loaded. Console cancellation targets the job's own process
group, including ordinary background descendants. Child environments omit
application credentials and runtime injection variables.

Finder launches receive standard system, Homebrew and user tool directories on
PATH without evaluating a login shell. The app supports native macOS menus,
Command shortcuts, Dock activation and macOS platform labels.

The existing reviewed Grove installation recipes are available on Apple Silicon
and Intel, with macOS Python/Codex discovery and executable symlink resolution.
Bundle checksums, schemas, receipts and MCP validation still apply. A changed
upstream bundle must be reviewed before its recipe is updated.

## Validation and limits

The macOS test suite covers architecture selection, binary integrity and modes,
process inspection, external service ownership, Finder PATH, Command shortcuts,
real zsh jobs, cancellation, and reviewed Grove fixtures. `test:mac` uses an
isolated profile with production Electron IPC to exercise native PTY input,
Unicode output, resizing, closure, console execution and Portal onboarding.

Apple Silicon has been exercised on real macOS hardware. Intel asset selection
and installation contracts have automated coverage; Intel runtime execution
still requires an Intel Mac. Desktop packaging does not install login-time
services or grant macOS privacy permissions. Existing Portal accounts and
permissions remain managed by their existing owner.
