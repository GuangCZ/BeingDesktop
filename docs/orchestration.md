# Orchestrator mode

Final results appear in their original conversation as Being's summary with collapsed evidence and, for web artifacts, an Open preview button. After a Worker completes, Being uses `desktop_worker_status action=present` with `artifactPath` (a workspace HTML entry or directory containing `index.html`) or `url` (an existing HTTP/S application), then records its final assessment with `action=review`. Desktop owns static hosting and opens the preview in its embedded browser when the conversation button is clicked. Reopening after restart uses the saved artifact, without executing the Worker again. Worker details remain execution diagnostics. CLI browser integrations are not required for this handoff.

Enable **Settings → 编排模式** after choosing a local workspace. Being refines requirements, delegates bounded tasks, waits for workers, and evaluates their results. The mode defaults to off and applies to every conversation on this Desktop. Toggling the switch detects available agents, saves the mode and configures enforcement immediately. A failed check restores the switch to its saved state. The switch cannot change while a local worker is executing; other Desktops keep their own modes. Dependent settings are disabled and greyed out when the mode is off.

## Agent adapters

- Codex CLI: `codex exec --json --sandbox workspace-write --skip-git-repo-check --color never -`. Detection checks the execution interface and `codex login status`. The selected workspace may be an ordinary directory rather than a Git repository; the workspace sandbox still applies. Prompts travel through stdin.
- Cursor CLI: `cursor-agent --print --output-format stream-json` (also detects the `agent` executable). Prompts travel through stdin. This adapter uses CLI, not Cursor SDK.
- Grok Build CLI: `grok --output-format streaming-json --prompt-file <file>`. The temporary prompt file is removed after execution.

The adapters use existing CLI login and permission configuration. Worker processes preserve configured HTTP, HTTPS, ALL and NO proxy environment variables, including lowercase forms, CLI-specific API keys and endpoints, `CODEX_HOME`, XDG configuration directories and custom CA certificate paths. Values come from the launching Desktop process; CLI configuration files remain local. Starting from Finder does not source shell startup files. Being credentials and another Desktop's model configuration are not copied into workers. Arbitrary environment variables, `NODE_OPTIONS` and TLS-verification bypasses are not forwarded. They do not request blanket permission bypasses. Cursor and Grok authentication is not independently verified by detection; execution failures remain visible. If the preferred agent is unavailable when enabling, the first detected executable agent is selected. With no executable agents, enabling fails. An unavailable worker never falls back to direct Being execution. No agent is installed automatically.

The documented event contracts are [Cursor output format](https://cursor.com/docs/cli/reference/output-format) and [Grok Build headless mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md). Codex invocation options were verified against the locally installed CLI's `exec --help` and `login --help`.

## Delegation and visibility

The desktop relay exposes only `desktop_worker_start`, `desktop_worker_list`, `desktop_worker_status`, `desktop_worker_wait`, and `desktop_worker_cancel` in this mode. A session capability binds each dispatch to its conversation; old capabilities are revoked when the mode or Being identity changes. `requestId` deduplicates dispatch retries. Workers in the same workspace execute serially to avoid concurrent file edits. Follow-up tasks should carry the relevant prior results in their prompt; this version starts a fresh agent run for each dispatch.

Workers appear beneath their owning conversation. The conversation list scrolls independently so long histories cannot hide workers below the window. Opening a worker shows its status, result, timestamped tool calls, and logs, with cancellation while running. Output is sanitized and bounded, and truncation is marked. A zero exit code without a provider success event is a failure. Codex reconnection notices are progress events: a later successful completion can still finish the worker. “Completed” means the agent run finished; Being must still evaluate whether the requested acceptance criteria were met.

Worker records live in the desktop user data directory under `workers`, partitioned by Being identity in the local profile. Each new record also contains its originating Desktop ID, process instance ID, platform, architecture, host, workspace and tool target. Records explicitly owned by another Desktop are excluded from loading, callback delivery and execution. A restart marks formerly active records interrupted and never replays them. Disconnecting or switching Being stops workers; merely switching desktop conversations keeps their workers running. Closing to the tray also keeps workers running.

## Completion and evaluation

Natural completion or failure persists the result before notifying Heart through its existing `/api/callback` endpoint. The callback contains a stable Worker identity and an opaque receipt identifier; it does not contain a session capability, execution instructions, or the full output. Transport failures retry the saved notification without rerunning the CLI. A successful inbox receipt and Being's evaluation are separate records.

The existing `desktop_worker_status` tool has four operations. `action=receive` validates the receipt against the current Being and saved original conversation, then supplies a current conversation capability. `action=read` reads the authoritative result and current presentation status. `action=present` displays a completed result through Desktop. `action=review` requires the capability plus an outcome, summary and evidence, and persists Being's assessment. The outcome can be `passed`, `failed`, or `needs_verification`. Duplicate reviews return the saved assessment. No additional tool names or gateway permissions are required.

The desktop routes the recorded assessment to the Worker's original conversation using a stable delivery identifier, including when a different conversation is selected. Worker details display execution status, notification receipt and evaluation independently. Further verification still runs through a CLI; `parentWorkerId` and the supplied `followUpRequestId` deduplicate a follow-up dispatch. Stopping continuation suppresses callbacks and prevents later receipt handling. Turning the mode off pauses delivery; reconnecting restores current capabilities instead of reusing historical tokens.

To continue an already authorized task with SBS off, Desktop also schedules one clearly labeled automatic task-continuation message after native receipt if Being is idle and evaluation is still pending. It does not change SBS or rerun the CLI. Uncertain submission is retained without blind reposting. See the [callback design](worker-callback-design.md) for the implementation boundary; a transport receipt alone does not establish that Being has evaluated the task.

## Desktop identity and execution isolation

Each local profile creates a persistent UUID in `desktop-id.json`. Restarting or updating the app preserves that ID. Independently installed Desktops generate distinct IDs; copying the entire user-data directory also copies its identity and is not a way to create a new Desktop.

The tool target is `being-desktop-tools-<desktopId>`. Session storage and reply channels include the Desktop ID and Being path. Outgoing conversation headers include the Desktop ID, session ID and request ID. Replies explicitly addressed to another Desktop or an unknown session are not imported. Existing local conversations migrate once without changing their session IDs. Legacy replies without a Desktop ID can still reach a known local session. Workers additionally require an ephemeral session capability: another Desktop cannot dispatch, read or cancel them using a matching session ID alone. Completion notifications include the originating Desktop ID and tool target.

Each Desktop selects direct or orchestrator mode independently. A Mac can expose its direct terminal/browser tools while a Windows Desktop exposes only its Worker tools to the same Being. The local tool bridge rejects tools outside its current mode and rejects a different target. Before a Worker task, Desktop verifies that its own bridge is connected and advertises Worker dispatch. Mode changes never read or write Being's shared model endpoint. No companion model gateway is required for this local mode.

This is client-side conversation routing and local tool enforcement, not a security boundary for the shared Being's server history or model context. The Being identity, memory, inference settings, remote tool availability and background runtime remain shared. Requests to the shared runtime may still queue. Routing instructions help Being choose the originating Desktop; a client ID alone cannot prohibit the shared model from choosing other independently exposed remote tools. CLI processes run locally and do not inherit another Desktop's authentication, proxy or workspace.

### Upgrading from the shared gateway mode

Older versions could rewrite Being's model URL to `/orchestrator/v1` and save the previous URL on only one computer. This version neither requires that recovery record nor automatically changes the shared URL. If the old gateway still blocks direct mode, confirm the normal model endpoint in Model settings once. That setting remains shared across the Being; use an endpoint appropriate for both Desktops. A globally filtering gateway cannot implement different per-Desktop policies without server support.

## History synchronization and recovery

If a user keeps an external model gateway, its failures retain their category: forbidden tools or hosted execution, unsupported response formats, upstream generation failures, incomplete output and response-size limits are reported separately. The companion gateway records fixed diagnostic codes without logging response text or tool arguments. All rejected output stays quarantined, including partial Worker calls; errors never trigger automatic task resubmission. Older `worker_only` errors cannot establish whether a tool violation or format problem occurred and are labeled accordingly.

Desktop preserves these categories across stream replay and reload, recovers an older compacted error from its own request's saved event, and coalesces unambiguous duplicate error rows from native history. Error timing starts when the request was sent; legacy error-only records without a known start omit the duration rather than showing a misleading zero.

Local result insertion and Loom history synchronization now share stable receipt identities. Native history reuses the matching visible row, restores its metadata after a rebuild and repairs unambiguous saved copies. It preserves user messages, distinct requests and ambiguous legacy text. This prevents the same local Worker result from being appended on every poll without rewriting remote Loom history.

## Nested CLI execution

A CLI started inside another Worker's shell inherits that Worker's sandbox and environment. A successful host-level Agent Kit check does not prove the nested invocation can access the same authentication, proxy or certificate configuration. In the live poker integration, the same installed Codex executable and arguments failed in the restricted nested path but succeeded on the host. A project-specific bounded host runner completed a real hand; that runner is not a general host supervision feature shipped in Desktop. Do not remove sandbox markers or disable TLS verification as a substitute for a supported host integration.

## Validation

`npm test` covers dispatch, persistence, mode switching, tool gating, callbacks, evaluation, result presentation and history deduplication. `npm run check` validates source syntax. `npm run test:orchestration` adds the Electron settings regression, using offline fixtures rather than a live Being or paid Agent task.

Earlier live Windows checks verified Codex execution, original-conversation callback delivery, separate receipt and evaluation states, result cards and embedded-browser previews. The history fix additionally passed repeated reconciliation and reload tests against the deployed Loom renderer in an offline fixture. A completed CLI run alone is not evidence that Being accepted the original task. The new multi-Desktop cases use isolated local fixtures, including native child-process environment checks; they do not establish simultaneous live Windows/Mac execution against the shared server. Cursor/Grok authentication requires separate environment-specific validation.
