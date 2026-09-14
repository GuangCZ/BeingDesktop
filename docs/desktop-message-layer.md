# Desktop 自建消息层：协议实测记录

`src/being-chat.cjs` 直接调用 Being 的五个消息端点，不再往 Loom 页面注入脚本。本文记录**实测**到的协议行为——尤其是 Loom 单会话形态下不会暴露、但 Desktop 多会话必然撞上的那些。

实测环境：真实 Being（`/api/status` 返回 `being_name`），Loom v1.7.0 → v1.8.0（2026-09-11 部署页与公开仓库 main 一致），2026-09-11。凭据不入库、不入日志。文中及源码注释里的 `loom.html:行号` 均按 v1.8.0。

## 端点与鉴权

```
POST /api/chat/stream     发送；空闲时给流，忙时并入当前呼吸
GET  /api/history         时间线（limit / after）
GET  /api/stream/active   探活 + replay 缓冲
POST /api/stop            打断
GET  /api/status          being 身份
```

**鉴权只认 `?token=`。** 带 `Authorization: Bearer` 会返回 403 —— 与 Town 客户端相反（Town 只认 header、不认 query）。两套客户端在同一个进程里，这条最容易写错。

## 一、发送并非总能拿到流

| 情况 | 响应 |
|---|---|
| Being 空闲 | `200 text/event-stream` |
| Being 正在呼吸 | `202 application/json` + `{"spliced":true}` |

`202` 意味着**消息已送达**，只是并入了正在进行的那口气，没有属于自己的流。

在 Loom 单会话下这是边角情况；在 Desktop 多会话下是常态——只要任一会话在流，下一个会话发消息就拿不到流。把 `202` 当失败处理会让用户重发，于是队列里排进两条一样的消息。**次生灾害比 bug 本身大。**

## 二、一条连接不属于一个会话

实测：会话 A 拿到流，A 的回复流完 `message_stop` 之后，**同一条连接**上出现了

```json
event: meta
data: {"continuation":true,"scene_id":"desktop-<desktopId>-<sessionId-B>"}
```

随后流出的是会话 B 的回复——B 自己的 POST 只拿到了 `202`。

这就是 loom.html:2852 注释里的 `breathe_leftovers`。对 Desktop 的含义比对 Loom 严重得多：

> **事件必须按 scene 路由，不能按 scene 过滤。** 过滤掉「不属于本会话」的事件，等于把并入发送的回复彻底丢弃——没有任何别的连接会再送一遍。

所以 `_consume()` 逐事件取 `scene_id` → 反解出会话 → 投递给那个会话；正文缓冲**按会话分开**，否则 B 的回答会拼进 A 的气泡。

会话与 scene 的映射是双向纯函数，路由不需要任何注册表：

```
scene_id = desktop-{desktopId}-{sessionId}      sceneId()
sessionId = scene 去掉前缀后的 UUID              sessionFromScene()
```

反解失败（`loom-being`、别的 Desktop 的 scene）说明这条事件不属于本机，丢弃并计入 `foreign`。

## 三、并发：服务端串行排队，scene 归属不串

同时发两条不同 scene 的消息，历史里是：

```
seq N+0  user       scene=desktop-…-A    "A 的问题"
seq N+1  assistant  scene=desktop-…-A    "A 的回复"
seq N+2  user       scene=desktop-…-B    "B 的问题"
seq N+3  assistant  scene=desktop-…-B    "B 的回复"
```

排队，不拒绝，**每条回复都盖了正确的 scene 章**。这是「会话 = scene」能成立的最硬证据：多会话并发下归属不会错乱。客户端不需要自己排队来保证正确性，只需要为了 UI 上能显示「排队中」。

## 四、打断：`/api/stop` 没有 scene 参数

`/api/stop` 停的是「当前那口气」。按第二、三节，那口气可能属于**另一个会话**。停错的后果不是少半句话，而是：

- 另一个会话的用户在等一个永远不会来的结尾；
- 半截回复可能落盘成看起来完整的一条，日后被当成完整观点引用。

Desktop 侧的做法（`stop()`）：先探活，从 replay 缓冲的**最后一条**带 scene 的事件判定当前这口气属于谁。

| 判定 | 行为 |
|---|---|
| 属于本会话，且还在说 | 停 |
| 属于别的会话 | 拒绝，返回 `other-scene` + 对方 scene，交给界面问用户 |
| 缓冲里没有 scene | 拒绝，返回 `unknown`，问用户而不是猜 |
| 最后一条事件是 `message_stop` | 拒绝，返回 `unknown` + 刚说完的 scene：下一条可能是给别的会话的 continuation，谁在说无法证明 |
| 空闲 / 已结束 | 拒绝，返回 `idle`（按钮本来就不该亮） |

`force: true` 是用户回答了那个询问之后的通道。

**剩余竞态堵不死**：探活时是 B 在流，`stop` 到达时 B 刚结束、A 刚开始——这一瞬间停掉的是 A。窗口很小但存在。根治需要服务端让 `stop` 带 `stream_id`（精确停某口气）或 `client_ref`（精确撤某条排队消息）。**待提 Heart 侧。**

## 五、探活与 replay

空闲时返回 `204`（无正文），不是 `null` JSON。

活跃时的字段：`events, finished, next_seq, origin, started_at, stream_id, trigger_message`。

replay 事件形如

```json
{"event":"reasoning","seq":1,"data":{"scene_id":"…","text":"The"}}
```

—— 与 SSE 的 `event:`/`data:` 分离形式不同，这里包成一层；`seq` 从 1 起、按流计数，`next_seq` 是续读位置。

**replay 事件带 `scene_id`。** 所以断线恢复在多会话下不瞎：恢复出来的缓冲和实时流一样按 scene 扇出。

`reasoning` 是思考流（`data.text`）。它实时展示但**不并入回复正文**，这样中途被打断时不会把思考当成答案落盘。

## 六、必须照抄的不变量

1. **`meta` 不占 seq**，其余事件与服务端 seq 严格 1:1 —— `probeStream` 判定「还在推进」的基石。
2. **`meta` 不进 replay 缓冲**（源码注释指向 `http.rs:1950`）。
3. **消息与游标同一事务落盘** —— 否则「游标推过去了、消息没落盘」，下次 `after=` 永远跳过。
4. **`lastSeq` 只前进。** 一个具体后果：`/api/history` 的返回游标只能取「过滤后的新行」的最后一个 seq。取未过滤整页的最后一行会在服务端忽略 `after` 时让游标**后退**。
5. **基线纪律** —— 有全量基线之前，增量写入只攒不落盘。

## 七、历史行：无 scene 的行不属于任何会话

历史行字段全集：`role, content, seq, at, from?, scene_id?` —— **没有 `session_id`**。`scene_id` 是服务端唯一持久化并回传的路由键；`client_ref` 会在 `meta` 上原样回传但**不落盘**（按实际值搜历史 0 命中），所以它只能做实时关联。

Loom 的规则是「没有 `scene_id` 的放行」（loom.html:3638）。Desktop **不能照抄**：一条时间线上有 N 个会话，放行会让所有旧消息涌进每一个会话。分隔行（`from: system`，如 `[breath yielded to human]`）也无 scene。

**过渡期的实际后果**：v1.7.0 之前的消息都没有 `scene_id`（实测 187 条历史里 157 条 assistant 行无 scene），这些消息在新界面里任何会话都看不到。这不是 bug，但体验像 bug——**渲染层必须给出一次性说明**，例如「所有会话共享同一个 being 的记忆，会话只是你的浏览视图；v1.7.0 之前的记录没有场景标记，未归入任何会话」，否则用户会报「对话全空了」。

## 八、一条时间线，一个全局游标，N 个投影

`/api/history` 不支持按 scene 查询（loom.html:3910 只用 `limit`/`after`，过滤在客户端）。所以是**一次拉取 → 按 scene 分发给 N 个会话**，不是 N 个读取器各拉一遍。

`history()` 额外返回 `ignoredAfter`：整页非空但没有一行新于 `after`，说明服务端忽略了 `after`。没有这个标志，调用方无法把它和「真的没有新消息」区分开，会反复读同一个窗口。

## 九、模块与职责（落地后）

| 模块 | 职责 |
|---|---|
| `src/being-chat.cjs` | 五个端点的客户端；scene ↔ 会话双向映射；逐事件路由；`router()` 跨连接续用；202 并入；归属化 `stop()` |
| `src/chat-store.cjs` / `src/chat-cache.cjs` | 每会话 transcript + 会话列表 + 全局游标，一个加密文件，三条不变量 |
| `src/being-recovery.cjs` | Loom 韧性逻辑的移植：分相位 watchdog、probe 判定表、replay 轮询、catch-up、自主呼吸 watch、断线排队恢复 |
| `src/chat-sessions.cjs` | 绑定一个 Being 身份；暂存态（已发未确认 / 流式中 / 已回未确认 / 中断的半截）；面向 IPC 的投影 |
| `renderer/chat-app.js` | 原生消息流、composer（图片：选取 / 粘贴 / 拖入，缩略图）、恢复提示、一次性说明；只画主进程投影的数据 |

`scene_meta.scene_label` 实测会进入 being 的感知（它看到的是 `[场景] <label>`），因此会话标题即话题门牌，随每条消息重发。

### 暂存项的确认规则

暂存项（发出的消息、流完的回复）从不落盘，由 history 行确认后退场：

- **一个 `message_stop` 一项**，不是一口气一项——服务端每个 stop 落一行，粒度必须对齐。
- **前缀容忍，双向**：流被切断留给我们的是落盘内容的前缀；服务端裁掉结尾则相反。共同前缀短于 8 个字符不算数，「好」不能被任何以「好」开头的行确认。误判的代价只是预览早退场一瞬（落盘行才是真相），漏判的代价是半截泡泡挨着它自己的行显示到过期——所以门槛设得低。
- **writer 结束必须 settle**：live reader / replay poller / 断线恢复意图彻底结束（gone、superseded、超时、放弃、dispose）时，它的 router 里还开着的气泡以 `settled` 事件通知会话层，变成一条标着「回复中断，等待记录核对」的半截项，由 history 按前缀确认或过期。没有这一步，`recoverViaHistory` 结束后「正在回复…」的光标会永远闪。
- router 随恢复意图一起走（live → pending → cutover → replay），所以断线续读拼出来的是整句，不是尾巴。从 seq 0 整体接管而放弃的意图，先 settle 再重放，重放出的整句会顶掉它自己的半截前缀。
- **调过工具的回复只落最后一个文本块**（2026-09-11 实测：流是「我去翻记忆。」→ `tool_use remember` → `tool_result` → 「翻完了，…」→ `message_stop`，history 里的 assistant 行只有「翻完了，…」，中间的 seq 被工具行占掉且 history 不返回）。所以会话层在 `tool_use` 处记下文本块边界，回复项同时带 `text`（说过的全部）和 `final`（最后一块），任一匹配即确认。确认后落盘行取代暂存项，开头的旁白随之消失——这和重新打开时看到的一致，落盘行才是真相。
- **过期按项计**：一项在三次「给这个会话落了新行却没确认它」的读取之后过期。只改标题、没落新行的读取都不算证据；邻项被确认也不再给它续命（之前的计数按会话，任何一次确认都清零，幽灵能一直活到会话结束）。
- **排序**：每项记下创建时会话里最新的行 seq（`after`），渲染时先排在这些行之后，再按时间插进后来落的行之间；回复项的时间取 `message_stop` 时刻（落盘行的 `at` 也是结束时刻）。这样没被确认的旧回复停在它被说出的位置，而不是压在后来的对话下面，本机时钟慢几秒也不会把刚发的消息抬到上一条回复前面。

### 沉默没有信号

一口气可能只用工具不说话，或者认真考虑后不回；协议上这和「还没轮到」无法区分。catch-up 等满 5 分钟放弃时用中性文案（「这口气没有留下给这个会话的话。」），不报错。根治要服务端在呼吸结束时给个 `breath_end {scene_id, spoke:false}` 之类的信号。**待提 Heart 侧。**

## 十、图片：`content` 块，只活一轮

实测 2026-09-11（真实 Being，模型 kimi-k3）：

发送体用 `content` 块数组代替 `message`：

```json
{"content":[{"type":"text","text":"…"},{"type":"image","media_type":"image/png","data":"<base64>"}],
 "scene_id":"…","scene_meta":{…},"client_ref":"…"}
```

| 实测 | 结果 |
|---|---|
| 文字 + 图片块 | `200 text/event-stream`，Being 直接看到图（黄底绿圆答对），没有调视觉工具 |
| `{"type":"audio"}` 块 | `422 text/plain`：`unknown variant \`audio\`, expected one of \`text\`, \`image\`, \`image_url\``，**没有落任何行** |
| 只有图片块、没有文字块 | `200` 有流，但 **history 里没有 user 行**（seq 被占掉，读不到），Being 把上一条文字消息当成当前问题来答，回复还盖了旧 scene 的标 |
| 9.5 MB PNG（请求体 12.7 MB） | 接受，模型看到。上传约 38 秒，`user` 行的 `at` 是正文收完的时刻 |
| 下一轮问「上一张图是什么颜色」 | 看不到——图片**不进历史、不进下一口气的感知** |

history 里的 user 行：`content` 是纯字符串，只有文字块的内容；字段全集不变（`role, content, seq, at, scene_id`），**没有任何字段承载图片**。

对 Desktop 的含义：

- 服务端只认 `text` / `image` / `image_url`，音频、视频没有入口，这两样要等 Heart 侧加，客户端改不出来。
- **图片必须配文字。** 没有文字的图片消息不但不落行，还会让 Being 答错问题，所以 composer 在文字为空时拒发。
- 包络取实测值：PNG / JPEG / WebP / GIF，每条消息合计 ≤ 10 MB，最多 8 张（`being-chat.cjs` 和 `chat-sessions.cjs` 各校验一次，前者不带文案）。
- 图片是**一次性感知**：Being 只在这一轮看到，记录里永远不会回来。所以缩略图（≤ 48 KB 的 data URL，渲染层生成，最长边 256）作为本机标注存在落盘行上：暂存的 sent 项带着它，被 history 确认时 `store.attach()` 挂到确认行，之后 `apply()` 重读同一 seq 保留它。
- 确认规则收紧了一处：**sent 项只认 `seq > after` 的行**。用户发过同样的话，旧行不该拿走这次的缩略图；一条 user 行不可能早于它自己的发送，所以这条收紧没有代价。replied 项保持「任意匹配行」——回复的行可能在回复收口之前就已经读到了。
- `usage` 事件（`input_tokens` / `output_tokens` / `cache_read_tokens`）每口气一条，现在原样透传给渲染层，尚未使用。

回退：设置 → 对话模式 → 「内嵌 Loom 页面」。旧路径完整保留（那边的图片走 `src/loom-attachments.cjs` 改写请求体，格式相同）。

## 原生会话的执行模式（2026-09-14 修复）

原生聊天发送前通过 main 提供的 `nativeMessageContext` 读取当前桌面环境与编排模式，并在编排模式中取得该会话的有效 Worker scope。Loom 和原生会话共用 `orchestrationInstructions`。`scene_id` 仍是唯一路由字段；环境和工具指令使用正文中的版本化长度帧传给模型，不依赖 `scene_meta` 被模型读取。

等待环境检查期间若连接、编排版本或模式发生变化，请求在 POST 前取消。关闭编排后，新消息携带直接模式说明，避免历史绑定影响当前操作。Worker 桥断线只阻止本机执行；Being 原生对话仍可发送。执行时继续由 `Orchestration.authorize` 和 `assertEnforced` 校验。

本机 `ChatStore` 在确认用户消息和写入缓存前去掉这层环境帧，保留原文、引用和图片预览；不会把绑定显示为用户消息，也不会因 `202` 或恢复读取重发。Worker 的验收和预览卡片由当前身份下的 Worker 历史按原会话投影，打开预览仍校验会话归属。

验证使用隔离的 Heart 响应、Worker 进程替身和 Electron 界面 fixture。覆盖有效绑定启动、重复请求去重、切换模式/身份的旧请求取消、桥断线、引用与图片确认、结果归属及预览入口；未重发用户原任务，也未把这些结果当成真实模型已调用 Worker 的证据。

### Worker 断线恢复与通知（2026-09-14）

调度 WebSocket 的网络断线会在编排模式下按 2、4、8 秒递增，最多间隔 60 秒自动重连。每次都重新认证与初始化；不会重放工具请求。主动断开、关闭编排、身份切换、退出应用会取消待重连，协议或鉴权拒绝不自动重试。

完成通知通过 Heart 原生 callback 发送，只依赖当前 Being 身份与连接；Worker 桥断线不再让通知保持零次发送。自动接续验收仍等待本机工具桥恢复，并检查编排绑定。回调、接续、验收结果分开记录；已确认或结果不确定的接续不盲目重发。

Heart 可能归一化连续换行。原生消息环境在计算帧长度前去掉尾部空白；缓存读取也能识别旧版被归一化但边界完整的帧，避免环境内容混入用户气泡。
