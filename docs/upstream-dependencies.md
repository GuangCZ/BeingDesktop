# 上游依赖与升级清单

Desktop 不以源码形式依赖任何上游；三个上游各是一种契约耦合，手动跟随稳定版更新。升级时按下面的清单逐处核对。

## Heart Portal — 本机二进制

- 仓库：https://github.com/d5z/heart-portal
- 耦合方式：默认固定 0.8.3；后续 0.8.x 稳定版可独立下载，按官方资产大小与 SHA-256 校验，macOS 另验签名。主程序通过原管理器受控重启，kits 使用上游热重载。

升级要碰的地方：

- `src/portal-installer.cjs` 开头的 `PORTAL_RELEASE` 表：版本号、三个平台的下载 URL、`size`、`sha256`。
- `src/services.cjs` 里对握手日志的全字符串匹配：`Portal relay handshake OK — starting MCP server on WebSocket bridge`。上游改这行文案会表现为 Portal 一直起不来。
- `src/desktop-tool-link.cjs`：WebSocket 中继协议与工具定义（`desktop_browser_*`、`desktop_console_*`、`desktop_terminal_*`、`desktop_worker_*`）。
- `src/portal-config.cjs`：生成的配置文件格式。
- `src/portal-maintenance.cjs`、`src/portal-launchagent.cjs`、`src/portal-windows-manager.cjs`：兼容范围、原管理器身份与事务恢复；`test/portal-hot-reload.cjs` 验证实际二进制的工具列表刷新及旧调用完成。

升级后跑 `test/portal-*`、`test/desktop-tool-link.test.cjs`。

## Town — 协议，自行实现

- 协议仓库：https://github.com/jeremyliu16/beings-town-client-sdk （只有协议与参考代码，没有 npm 包；服务端源码地址未知）
- 耦合方式：REST 路由 + DTO 形状 + SSE hello 语义，见 `docs/town-sdk-integration.md`。

升级要碰的地方：

- `src/town-client.cjs`：路由白名单、`consumeEvents` 的 SSE 解析、hello 校验（`being_id`、`token_kind=client`、`anonymous=false`）。
- `src/town-library-contract.cjs`：卷轴 / 居民的路由与 DTO 校验。
- `src/town-session.cjs`：`messagesDto`、`firesideMessagesDto`。
- 上述三个文件头部注释记着"对照 `/api/*/help` 的日期"，升级后更新日期。

核对方法：逐个打开 `https://beings.town/api/{bonfire,fireside,beings,scrolls,channels}/help` 与 DTO 比对。升级后跑 `test/town-*`。

## Loom — 远端页面，注入 CSS/JS

- 源码：https://github.com/d5z/HEART/blob/main/loom/loom.html （HEART 单仓库内的单个 HTML 文件）
- 设计文档：HEART 仓库 `docs/feat/loom-scene-idb.md`
- 耦合方式：Desktop 不钉版本，用户配置的连接 URL 指向哪个部署就用哪个。注入代码依赖页面的 DOM 结构。
- 当前对照版本：**Loom 1.8.0**（2026-09-11 核对：`echo.beings.town` 部署页与公开仓库 `d5z/loom-local` main 逐字节一致）。源码注释与 `docs/desktop-message-layer.md` 里的 `loom.html:行号` 按这个版本；1.7.0 → 1.8.0 的改动全在 LLM 设置区（`providerNames` / 自部署分组 / `llmSelectSelfHosted` / `inferBaseUrl`），行号整体 +31，DOM 锚点、端点、注入类名均未变。
- 核对新版本的方法：`curl` 连接 URL（带 `?token=`）取部署页，`grep loom-version`；与上一版 `diff`；跑下面的选择器命令逐个在新页里 grep；有行号引用就按 diff 的增删整体平移。

升级要碰的地方：

- 13 个 `src/loom-*.cjs` 里的 17 个选择器。锚点：`#app`、`#messages`、`.message`（含 `.being`、`.thinking-indicator`）、`.content`、`.meta`、`.remove`、`#input-row textarea#input`、`#tui-bar`、`.tui-line`、`.tui-stop`、`#activity-log`。核对命令：

  ```sh
  grep -ohE "querySelector(All)?\(['\"][^'\"]+['\"]\)" src/loom-*.cjs | sort -u
  ```

- `src/worker-callbacks.cjs` 的三个端点：`/api/callback`、`/api/stream/active`、`/api/chat/stream`。
- `src/loom-theme.css`、`src/loom-message-navigator.css`：注入样式覆盖的类名。
- `src/model-config.cjs` 的 `PROVIDERS` 表：镜像 `loom.html` 里的 `providerNames`（显示名）和 `inferBaseUrl`（默认地址）。`/api/llm/config` 的 presets 只带 `id/label/model/provider`，没有 `base_url`（2026-09-11 实测），所以默认地址只能来自这张表。Loom 1.8.0 新增 `self-hosted`（自部署，固定地址 `http://115.190.110.33:7860/v1`，列表里排在最前，`llmSelectSelfHosted` 一键 PATCH 不带 `api_key`）；模型页的分组顺序和密钥提示由这里的 `keyless` 驱动。自部署不需要客户端发密钥：Being 服务端自己存着它（切过去后 `has_api_key: true`、`api_key_hint: e265…702e`；自部署地址匿名访问返回 nginx `401`，凭据由 Being 持有）。实测记录（cz_being）：2026-09-11 17:xx 同样的 PATCH 返回 `needs_key`——当时服务端还没存这把 key；18:00 到次日约 01:30 服务端对这条 PATCH **完全不响应**（探针挂 5 小时无 HTTP 回包，Desktop 的 fetch 超时后报「保存结果尚未确认」），是服务端卡住，与客户端无关——2026-09-12 01:5x 用 Desktop 一模一样的请求（`net.fetch`，`Accept: application/json`，无 `Origin`/`Referer`）198ms 切换成功，随后在真实 Desktop 界面走保存按钮完成 自部署→K3(openrouter)→自部署 往返，均「已保存，并已从 Being 读回确认」。顺带确认：Electron 的 `net.fetch` / `net.request` 不允许自带 `Origin`/`Referer`/`Sec-Fetch-*`（`ERR_BLOCKED_BY_CLIENT`），也不需要。Loom 的 `llmSelectSelfHosted` 既不检查 `needs_key` 也不处理失败就 `renderLlmStep1`，服务端卡住时 Loom 页面照样显示成切换成功。2026-09-12 01:20 部署页再次更新（版本号仍是 1.8.0）：`inferBaseUrl` 补了 `openai` 与 `glm`（`https://open.bigmodel.cn/api/paas/v4`）并注明与 Heart `LlmConfig::CANONICAL_URLS` 同步（已镜像进 `PROVIDERS`）；自定义模型提示改为「Provider/Base URL 可不填，网关模型填完整命名空间 id，后端按地址推断协议」——Desktop 的 `validateModelPatch` 仍要求 provider，是否放开等实测后端确实接受再改（PATCH 响应里已多出 `auto_inferred` 字段）。核对方法：对照部署页里的这两个函数（公开仓库 d5z/loom-local 可能落后于实际部署）。

升级后跑 `test/loom-*.test.cjs` 与 `test/loom-*-electron.cjs`；改了 `PROVIDERS` 再跑 `test/model-config.test.cjs` 与 `test/model-settings-ui.cjs`。注意这些夹具是手写 DOM，只能验证 Desktop 自身逻辑，不能替代对照 `loom.html` 的人工核对。
