# Orchestrator mode

Final results appear in their original conversation as Being's summary with collapsed evidence and, for web artifacts, an Open preview button. After a Worker completes, Being uses `desktop_worker_status action=present` with `artifactPath` (a workspace HTML entry or directory containing `index.html`) or `url` (an existing HTTP/S application), then records its final assessment with `action=review`. Desktop owns static hosting and opens the preview in its embedded browser when the conversation button is clicked. Reopening after restart uses the saved artifact, without executing the Worker again. Worker details remain execution diagnostics. CLI browser integrations are not required for this handoff.

Enable **Settings → 编排模式** after choosing a local workspace. Being refines requirements, delegates bounded tasks, waits for workers, and evaluates their results. The mode defaults to off and applies to every desktop conversation. Toggling the switch detects available agents, saves the mode and configures enforcement immediately. A failed check restores the switch to its saved state. The switch cannot change while Being or a worker is executing. Dependent settings are disabled and greyed out when the mode is off.

## Agent adapters

- Codex CLI: `codex exec --json --sandbox workspace-write --skip-git-repo-check --color never -`. Detection checks the execution interface and `codex login status`. The selected workspace may be an ordinary directory rather than a Git repository; the workspace sandbox still applies. Prompts travel through stdin.
- Cursor CLI: `cursor-agent --print --output-format stream-json` (also detects the `agent` executable). Prompts travel through stdin. This adapter uses CLI, not Cursor SDK.
- Grok Build CLI: `grok --output-format streaming-json --prompt-file <file>`. The temporary prompt file is removed after execution.

The adapters use existing CLI login and permission configuration. Worker processes preserve configured HTTP, HTTPS, ALL and NO proxy environment variables, including lowercase forms, and `CODEX_HOME`. They do not request blanket permission bypasses. Cursor and Grok authentication is not independently verified by detection; execution failures remain visible. If the preferred agent is unavailable when enabling, the first detected executable agent is selected. With no executable agents, enabling fails. An unavailable worker never falls back to direct Being execution. No agent is installed automatically.

The documented event contracts are [Cursor output format](https://cursor.com/docs/cli/reference/output-format) and [Grok Build headless mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md). Codex invocation options were verified against the locally installed CLI's `exec --help` and `login --help`.

## Delegation and visibility

The desktop relay exposes only `desktop_worker_start`, `desktop_worker_list`, `desktop_worker_status`, `desktop_worker_wait`, and `desktop_worker_cancel` in this mode. A session capability binds each dispatch to its conversation; old capabilities are revoked when the mode or Being identity changes. `requestId` deduplicates dispatch retries. Workers in the same workspace execute serially to avoid concurrent file edits. Follow-up tasks should carry the relevant prior results in their prompt; this version starts a fresh agent run for each dispatch.

Workers appear beneath their owning conversation. The conversation list scrolls independently so long histories cannot hide workers below the window. Opening a worker shows its status, result, timestamped tool calls, and logs, with cancellation while running. Output is sanitized and bounded, and truncation is marked. A zero exit code without a provider success event is a failure. Codex reconnection notices are progress events: a later successful completion can still finish the worker. “Completed” means the agent run finished; Being must still evaluate whether the requested acceptance criteria were met.

Worker records live in the desktop user data directory under `workers`, partitioned by Being identity. A restart marks formerly active records interrupted and never replays them. Disconnecting or switching Being stops workers; merely switching desktop conversations keeps their workers running. Closing to the tray also keeps workers running.

## Completion and evaluation

Natural completion or failure persists the result before notifying Heart through its existing `/api/callback` endpoint. The callback contains a stable Worker identity and an opaque receipt identifier; it does not contain a session capability, execution instructions, or the full output. Transport failures retry the saved notification without rerunning the CLI. A successful inbox receipt and Being's evaluation are separate records.

The existing `desktop_worker_status` tool has four operations. `action=receive` validates the receipt against the current Being and saved original conversation, then supplies a current conversation capability. `action=read` reads the authoritative result and current presentation status. `action=present` displays a completed result through Desktop. `action=review` requires the capability plus an outcome, summary and evidence, and persists Being's assessment. The outcome can be `passed`, `failed`, or `needs_verification`. Duplicate reviews return the saved assessment. No additional tool names or gateway permissions are required.

The desktop routes the recorded assessment to the Worker's original conversation using a stable delivery identifier, including when a different conversation is selected. Worker details display execution status, notification receipt and evaluation independently. Further verification still runs through a CLI; `parentWorkerId` and the supplied `followUpRequestId` deduplicate a follow-up dispatch. Stopping continuation suppresses callbacks and prevents later receipt handling. Turning the mode off pauses delivery; reconnecting restores current capabilities instead of reusing historical tokens.

To continue an already authorized task with SBS off, Desktop also schedules one clearly labeled automatic task-continuation message after native receipt if Being is idle and evaluation is still pending. It does not change SBS or rerun the CLI. Uncertain submission is retained without blind reposting. See the [callback design](worker-callback-design.md) for the implementation boundary; a transport receipt alone does not establish that Being has evaluated the task.

## Strict model boundary

The companion gateway must also suppress implicit tool injection in the downstream model proxy. CLIProxyAPI's Codex executor normally adds a hosted `image_generation` tool even after a caller has supplied a restricted function list. The gateway now sets the proxy's existing Responses Lite no-injection signal in both the request header and `client_metadata`. This preserves the Worker-only tool list through the executor without changing ordinary model requests or Worker image-generation access. Response quarantine remains active as a second check.

This mode requires the updated desktop and a separately deployed model boundary implementing `being-orchestrator/1`. The reference deployment uses the companion proxy project's `internal/orchestration`; that code and gateway binary are not bundled in this Electron repository. The remote Being must use the OpenAI Responses provider through that boundary. It can run inside the updated CLIProxyAPI server or in the independent `cmd/orchestrator-gateway` process in front of an existing local proxy. A desktop-only update without either endpoint will refuse to enable the mode.

The reference deployment runs the gateway in front of the existing model proxy. Publish its capability and strict Responses routes at an address reachable by both Desktop and the remote Being. Service startup, authentication and HTTPS exposure belong to the gateway deployment; do not assume local loopback addresses on the desktop are reachable from the remote runtime.

The proxy exposes `/orchestrator/capabilities` and an authenticated `/orchestrator/v1/responses` endpoint. Enabling verifies the capability protocol, stores the original model URL locally, changes Being's model URL from `/v1` to `/orchestrator/v1`, and reads back the configuration. This changes the model endpoint for the connected Being, including its other conversations. Disabling restores the saved original URL only if the current configuration still matches the strict endpoint. A separately changed provider or address is preserved.

The strict endpoint removes all tools except the five desktop worker functions, removes previous-response references and omits background generation parameters (Codex rejects even `background: false`). Tool-free model probes can produce text only. The companion `/orchestrator/v1/chat/completions` route supports Loom's configuration probe, which uses Chat Completions even for Responses models. This probe route permits synchronous text only and rejects every tool request or response. Requests offering tools without an executable worker dispatch function on the Responses route are rejected. Both JSON and streamed Responses output is buffered and inspected before any model output reaches the remote runtime. Direct, hosted, undeclared or incomplete tool responses fail without exposing execution calls. Being's model text arrives after the complete response passes validation; worker events continue updating live. The regular `/v1` endpoints remain available to CLI workers.

Before each desktop message and worker dispatch, the desktop verifies that Being still uses the strict endpoint and that its capability check passes. Sending also requires the worker bridge to advertise dispatch. A changed endpoint or disconnected bridge blocks the task. There is no fallback to direct execution.

If Chromium cannot connect to the public capability endpoint, the desktop retries that same endpoint with Node's transport. It still requires the same protocol, provider and enforcement response. An HTTP refusal or invalid capability response is never retried through another transport.

This is enforced at the configured model boundary, not through remote runtime permissions. It does not revoke independent runtime background jobs, stop tasks already started elsewhere, or prevent an administrator from changing the model configuration. Such remote configuration changes are detected before the next desktop message or worker dispatch. The switch requires Being to be idle before changing endpoints.

## History synchronization and recovery

Model failures retain their category: forbidden tools or hosted execution, unsupported response formats, upstream generation failures, incomplete output and response-size limits are reported separately. The companion gateway records fixed diagnostic codes without logging response text or tool arguments. All rejected output stays quarantined, including partial Worker calls; errors never trigger automatic task resubmission. Older `worker_only` errors cannot establish whether a tool violation or format problem occurred and are labeled accordingly.

Desktop preserves these categories across stream replay and reload, recovers an older compacted error from its own request's saved event, and coalesces unambiguous duplicate error rows from native history. Error timing starts when the request was sent; legacy error-only records without a known start omit the duration rather than showing a misleading zero.

Local result insertion and Loom history synchronization now share stable receipt identities. Native history reuses the matching visible row, restores its metadata after a rebuild and repairs unambiguous saved copies. It preserves user messages, distinct requests and ambiguous legacy text. This prevents the same local Worker result from being appended on every poll without rewriting remote Loom history.

## Nested CLI execution

A CLI started inside another Worker's shell inherits that Worker's sandbox and environment. A successful host-level Agent Kit check does not prove the nested invocation can access the same authentication, proxy or certificate configuration. In the live poker integration, the same installed Codex executable and arguments failed in the restricted nested path but succeeded on the host. A project-specific bounded host runner completed a real hand; that runner is not a general host supervision feature shipped in Desktop. Do not remove sandbox markers or disable TLS verification as a substitute for a supported host integration.

## Validation

`npm test` covers dispatch, persistence, mode switching, tool gating, callbacks, evaluation, result presentation and history deduplication. `npm run check` validates source syntax. `npm run test:orchestration` adds the Electron settings regression, using offline fixtures rather than a live Being or paid Agent task.

Live Windows checks verified Codex execution, original-conversation callback delivery, separate receipt and evaluation states, result cards and embedded-browser previews. The history fix additionally passed repeated reconciliation and reload tests against the deployed Loom renderer in an offline fixture. A completed CLI run alone is not evidence that Being accepted the original task. Cursor/Grok authentication and macOS execution require separate environment-specific validation.
