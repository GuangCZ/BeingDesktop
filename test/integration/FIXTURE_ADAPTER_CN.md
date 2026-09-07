# 固定响应 MCP 诊断适配器

`fixture-adapter.cjs` 用于后续验证真实 Heart 的认证、工具路由和返回路径。它不是官方 heart-portal 的文件工具，不读取工作区、运行命令、抓取网页、执行 OAuth、加载自定义工具或 kits。导入模块不会启动连接或读取本地凭据。

## 唯一业务工具

- 工具名：`diagnostics_roundtrip`
- `inputSchema`：`{ type: 'object', properties: {}, additionalProperties: false }`
- 调用必须明确提供 `arguments: {}`；省略、null、数组、任意字段或额外调用参数均拒绝。
- 精确返回：

```json
{"content":[{"type":"text","text":"BEING_TOOL_ROUNDTRIP_OK_V1"}],"isError":false}
```

结果没有时间、主机名、PID、路径、身份或其他本机信息。协议层另允许 `initialize`、`ping`、`tools/list`；所有其他方法与工具默认拒绝。无 id 通知不执行工具且不回复。每个入站帧限 16 KiB UTF-8，拒绝批量数组、二进制及一帧多个 JSON 消息。

## 接口

```js
const { FixtureAdapter, handleMcpText, TOOL_NAME, FIXTURE_MARKER } = require('./fixture-adapter.cjs');

const adapter = new FixtureAdapter({ onEvent: (event) => recordSafeSummary(event) });
await adapter.connect({ relayUrl, beingId, loomToken, portalName: 'desktop-diagnostics' });
const state = adapter.state;
await adapter.dispose();
```

`handleMcpText(string)` 是纯协议处理函数，返回 `{accepted, fixtureProcessed, category, response}`；不执行任何 I/O。`response.id` 保留合法的本次请求 id，仅用于原连接返回，不写入活动记录。

连接参数由调用方显式提供：`relayUrl` 必须是没有用户名、密码、query、fragment 的 `wss://…/_relay`，仅回环地址允许 `ws`。令牌只进入首个身份握手文本帧，不拼入 URL，不导出到状态和事件。Portal 名称仅接受专用的 `desktop-diagnostics` 或同前缀的诊断名称，禁止冒用 `cz-win`。

官方 Portal 从 **Loom URL 本身**的 host 推导中继地址，从第一个非空路径段推导 being id；不是取 `api` 参数的最后一个路径段。调用方应据此解析原连接，不能猜测其他 Being 路由。

握手必须是严格的 `ok: true`，并声明 `relay_keepalive: 'text-v1'`。本适配器使用原生 Node WebSocket，仅实现协商后的文本 keepalive。握手成功时 `status=connected`，事件为 `handshake_accepted`。它不自动重新连接或重发请求。

## 计数与请求关联

公开状态只有固定状态、事件类别和计数：

```js
{
  status, // idle / connecting / connected / disconnected / error / stopped
  lastEvent,
  counters: {
    received, accepted, denied,
    fixtureExecutions, responsesSent, fixtureResponsesSent
  },
  lastFixture: {
    requestIdSha256, // SHA256(JSON.stringify(request.id)); no original id
    processingCount,
    responseQueued
  }
}
```

`lastFixture` 在首次合法工具调用前为 null。每次接受诊断工具时，`fixtureExecutions` 增加 1；只有固定响应成功进入 WebSocket 发送队列后，`fixtureResponsesSent` 增加 1，`responseQueued=true`。发送失败不会声称响应已入队。

SHA256 仅用于本轮请求关联，不用于匿名化保证或访问认证；调用方仍应使用自己的 `runId`，且不记录原始 id、消息正文、令牌或授权 URL。**计数和发送入队不证明 Heart 或 Being 已收到响应**；真实验收还需同轮请求关联、端侧增量为 1，以及 Being 返回精确固定标记。只看到工具列表或模型自称成功不算通过。

`stop` / `dispose` 立即禁用请求处理、清理定时器并请求关闭自己的连接；不会停止其他进程或生产 Portal。旧 socket 的迟到事件无法重新激活会话。调用方负责限制本轮总运行时间和禁止同名诊断实例并行。

## 本机验证

```powershell
node --test test/fixture-adapter.test.cjs
```

72 项测试已通过，覆盖固定工具结果、默认拒绝、参数与大小边界、通知、工具名、原始内容不进事件、计数、请求 id 摘要、握手、心跳、停止、背压和消息总数限制。其中一项使用真实 Node 原生 WebSocket，经过仅监听 `127.0.0.1` 的受控中继，完成一次固定诊断工具调用并验证同 id 响应、精确标记和计数增量。

这些测试没有连接生产 Heart，没有使用真实 Loom 凭据。它们不证明官方 Portal 通用文件权限或生产工具业务链路已经验证。
