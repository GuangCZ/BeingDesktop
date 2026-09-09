# Worker completion callback integration

Implemented in Desktop on 2026-09-09 after discussions with the connected Being. Inbox acceptance and task acceptance remain separate states.

## Cause and decision

Previously, child.done saved the Worker result and notified the desktop renderer. An ended Being turn could not resume through that UI notification. Polling tools worked only while Being continued calling them.

Desktop now uses Heart's existing POST /api/callback transport. It retains the five Worker tool names and strict gateway boundary. Desktop owns durable execution results, original-conversation mapping, notification retry and evaluation delivery. This implementation needs no Heart source change, task-registration call or additional gateway permission.

## Native transport evidence

The reviewed codex-async 1.1.2 archive has SHA-256 b82ec8aa888bfb86108a499e86804ca29ab487171dd07bf4948e452090b94d1d. Its inspected sender files match that archive. It creates task IDs locally and posts {source, task_id, summary, result} using the Loom token query parameter. The cached Portal process_manager.rs uses the same endpoint. The Kit changelog corrects an older Bearer-auth description.

Live checks confirmed missing/wrong tokens return 403, a fresh unregistered task returns 202 with accepted:true and inbox_id, and an exact duplicate returns the same inbox ID. A discussion-only event reached Being with SBS disabled. These observations establish transport behavior for this deployment; actual Worker evaluation requires a separate end-to-end check.

## Durable completion

WorkerCallbacks.prepare creates a stable receipt ID after natural completion or failure. The authoritative terminal result and notification are flushed before sending. The envelope uses source=being-desktop-worker, task_id=worker.id, and result.protocol=being-desktop-worker-result/1. Bounded metadata includes the receipt ID, original conversation ID, start request ID and terminal state. It contains no session token, full output or instructions.

The sender uses the current owning Being's connection and rejects redirects and unrecognized responses. Only accepted JSON with an inbox ID records acceptance. Network errors, 429 and server errors retry the same task and receipt IDs; retries never rerun the CLI. Cancellation suppresses continuation. Mode-off pauses delivery; identity changes abort in-flight delivery. Restart recovers interrupted sends and current conversation capabilities, without replaying interrupted CLI execution.

## Trusted continuation through existing tools

The desktop_worker_status tool supports four operations:

| Operation | Required input | Effect |
| --- | --- | --- |
| receive | Opaque callback ID and advertised Portal target | Validate the saved receipt, current Being, original conversation, terminal task and strict mode; return a current conversation capability and original task context. |
| read (default) | Session ID, current session token, Worker ID and Portal target | Read authoritative result and bounded recent events. |
| review | Read binding plus outcome, summary and evidence | Persist Being's evaluation once and deliver it to the original conversation. |
| present | Read binding plus exactly one artifactPath or url | Ask Desktop to display the completed Worker's result in its embedded browser; static HTML is served by Desktop until shutdown. |

Receive restores a binding from trusted saved state; a payload-supplied conversation ID cannot grant access. Review requires the normal conversation capability. Trusted tool descriptions define event handling; arbitrary Worker output remains data. Empty optional properties inserted by model adapters are normalized only when irrelevant to the operation; required identifiers and evidence remain validated.

Being may record passed, failed, or needs_verification. Missing evidence must not become a pass. Further execution or verification goes through a CLI. A follow-up includes parentWorkerId and the supplied stable followUpRequestId; repeated dispatch returns the existing child. Each parent supports one such follow-up; further stages can chain through its child.

Result presentation belongs to Desktop. A CLI does not need an `iab` connection to deliver a webpage. Being calls `desktop_worker_status action=present` with the original Worker binding and either an HTML entry inside that Worker's workspace or an existing HTTP(S) service URL. The presentation action does not build files, run scripts or start application commands. Desktop serves static assets on loopback and opens its own embedded browser. The static server survives Worker exit and is stopped when Desktop closes or changes Being identity. Dynamic applications still need their application service running.

Subsequent status reads include the presentation's loading, loaded, failed, closed or navigated state and whether the tab is currently visible. Loading a page does not prove its interaction tests passed. A repeated presentation reuses its unchanged tab; concurrent duplicates share one request. Presentation does not overwrite an earlier review.

Final delivery belongs in the original conversation. Desktop renders Being's summary, collapsed evaluation evidence and an optional Open preview button in one durable result card. Preparing an artifact keeps the conversation visible; clicking its preview opens Desktop's embedded browser. The preview link carries only the Worker identity, and the host checks its conversation ownership before reopening the saved artifact. It can restore a static preview after restart without running the Worker again. Result metadata is isolated by conversation; repeated delivery and subsequent evaluation update the same card. Worker details contain execution history and diagnostics, without a result-path form.

## Delivery and visibility

Execution status, Heart receipt and Being evaluation are separate UI fields. Review delivery uses the original conversation and a stable request/delivery ID, so changing the selected conversation does not redirect the conclusion. Durable renderer routing deduplicates repeated delivery. A failed report retains the committed evaluation for another delivery attempt.

Duplicate receive/review calls return the saved evaluation. Local review commit and report are idempotent; this does not claim exactly-once remote model generation. An accepted native event is not resubmitted as a new Worker task.

Live validation found that inbox acceptance did not automatically trigger evaluation with SBS off. Desktop therefore checks the existing active-stream endpoint and, when Being is idle and the result remains pending, sends one explicitly labeled automatic task-continuation message through the existing chat transport. This message identifies the original Worker and directs Being to the receipt-validation tool; it is not presented as a new human instruction. It contains no result text or historical capability. The strict gateway still permits only Worker tools, and receipt/review validation still enforces the saved task scope.

Continuation state is flushed before POST. A busy Being is left alone until idle. A response lost after submission is recorded as uncertain and is not blindly reposted. A restart preserves that uncertainty. Native event handling can win before continuation dispatch; duplicate assessment still returns the committed review. The chat transport may schedule another model turn, so exactly-once model generation is not claimed. Desktop does not change SBS settings in this path.

An HTTP success is not proof of successful evaluation: the continuation reader also checks SSE error events. Explicit HTTP/SSE 429 and 5xx failures allow up to three evaluation attempts with 10/20-second backoff. A failed in-progress evaluation returns to pending; completed evaluations remain immutable and are delivered normally. Exhausted or non-retryable failures expose the existing manual continuation control. Retries preserve the completed Worker and its stable follow-up identifiers; they never restart its CLI. Unknown delivery after a network interruption remains uncertain instead of entering automatic retry.

Model API errors shown in conversation and process history use a compact HTTP-status message rather than upstream HTML. Repeated errors within the same request are deduplicated, while separate failed requests remain visible. User-authored text and normal tool outputs are preserved. Existing raw process events remain available in local diagnostic storage.

## Verification boundary

Regression tests cover result-before-notification ordering, stable retries, original-session delivery while another session is selected, fresh capabilities after restart, owner and cancellation checks, review and follow-up deduplication, delivery failures, and UI state separation. Real Worker validation must establish deployed SBS-off continuation and tool use; a 202 response or discussion-only event is insufficient evidence.
