# BeingAnywhere

Being 的 Chrome Manifest V3 扩展，支持 Chrome 和 Edge。选中网页文字后直接出现紧凑提问条，发送后原地展开对话小窗；可在浮窗继续追问，或移到原生侧栏接续同一段对话。当前版本 0.2.9。

## 安装

要求 Chrome 116 或更新版本，或当前版本的 Chromium Edge。

1. 在 Chrome 中打开 `chrome://extensions`，或在 Edge 中打开 `edge://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录 `extensions/being-anywhere`，其中应直接包含 `manifest.json`。
3. 将 BeingAnywhere 固定到工具栏。打开插件的设置页，粘贴原本在 Being Desktop 使用的完整 Loom 地址，点击「保存并验证连接」。仅为该 Being 服务授权网络访问。
4. 安装或更新后刷新已经打开的网页，使划词按钮生效。

从 ZIP 安装时先解压，选择直接包含 `manifest.json` 的文件夹。本预览版尚未发布至 Chrome 应用商店。

**更新已安装版本**：将新版 ZIP 解压并覆盖原来的扩展目录，在浏览器扩展管理页点击 BeingAnywhere 的「重新加载」，确认版本显示为 0.2.9，然后刷新需要划词的网页。继续使用原目录可保留扩展的连接设置。

0.2.9 移除悬浮聊天小窗欢迎区内重复的 Be 标识，标题直接显示「问问 Being」。

0.2.8 修复输入法组词状态阻止快捷按钮发送的问题。「解释／总结／翻译」直接发送对应问题及选中原文，不填入提示词或覆盖草稿；手动发送仍会保护尚未完成的输入。

0.2.7 将工具栏弹窗、聊天小窗与侧栏的设置齿轮统一为 Being Desktop 的同一份 SVG，保留原图的填充轮廓，避免被通用描边样式改变外形。

0.2.6 换用已确认的 Being Desktop 原稿 Logo，保持 Be 字形、比例、字距与方格排列，仅使用原稿缩小后的抗混叠资源。界面按显示尺寸与屏幕密度加载对应 PNG；任务栏和工具栏等极小尺寸下，细网格会自然变弱。

0.2.5 修复了浏览器原生 `fetch` 的调用上下文：此前在请求发出前可能抛出 `Illegal invocation`，被误显示为“无法连接 Being”。该修复同时覆盖保存验证、历史读取与流式聊天请求。更新后请重新打开设置页，再点击「保存并验证连接」。

## 使用

### 0.3.0：安装 MCP / Skill 链接

- 右键 GitHub 仓库、目录或文件链接 →「安装 MCP / Skill 到 Being」，直接在侧栏发送安装请求。
- 划选完整 GitHub URL，或将 URL 粘贴到划词提问条，点击出现的「安装」按钮，原地展开对话。
- 小窗与侧栏点击「安装链接」，粘贴链接，选择自动识别／MCP／Skill，再点「安装到 Being」。普通聊天草稿保留。
- 当前支持 `https://github.com/...` 与 `https://raw.githubusercontent.com/...`；`SKILL.md` 文件可识别为 Skill，其他链接由 Being 阅读后判断。不接受含凭据或不明查询参数的链接。
- 安装由当前连接的 Being 执行，通过已有 Loom 对话显示实际思考、工具过程与回复。扩展没有新增通用安装 API，也不在浏览器或 Codex 中执行仓库代码。Being 必须具备相应加载器、依赖与安装权限；合集选择、密钥、安装目标不明或覆盖配置时在对话中补充。
- “就绪”只表示本轮回复结束，安装是否成功以 Being 的实际加载和可用性检查结果为准。停止接收不会取消服务端安装；连接中断后先同步历史，不自动重复发送安装请求。
- 此功能已通过离线界面、消息传递和链接校验测试，尚未验证真实第三方 MCP／Skill 的安装。

划词提问条、聊天小窗、工具栏窗口、侧栏、设置页和回复进度头像统一使用确认版原稿 Be Logo，并保留统一黑白灰配色、细线图标及扁平控件。

- **划词提问条**：在网页中选择文字，紧凑的 Being 输入条自动出现在选区旁。它不会抢走网页焦点。点击输入框后保留所选原文快照，并用灰阶高亮标记引用范围。点击「解释」「总结」「翻译」即发送对应问题，不填入或覆盖输入框中的草稿；也可自行输入问题，按 Enter 或发送箭头提交。发送后立即原地展开对话小窗。
- **紧凑预览**：提问条与输入框不显示滚动条。长草稿在输入框失焦后显示两行省略预览；重新点击即可继续编辑，发送时保留完整文字。后续消息在展开的聊天小窗中显示。
- **展开对话小窗**：回复在网页旁流式出现，可继续追问、同步历史、停止接收和收起。关闭按钮隐藏小窗，当前网页中的对话仍保留；刷新或离开网页会终止该页面中的接收。
- **实时过程**：根据服务端事件显示「Being 在思考」「Being 在行动」「Being 在回复」及对应动效。返回的思考摘要和工具过程逐段更新，默认折叠；回复正文直接流式显示。系统启用减少动态效果时停用循环动画。
- **等待与接续**：服务端先接收消息、稍后回复时，自动只读检查关联的活动流与历史，不重复提交问题。无法确认归属时显示等待回复，可手动同步历史；「停止」会结束本地接收与检查。
- **转到侧栏**：本轮回复结束后点击「移到侧栏」图标，将已有消息、会话标识与未发送草稿一起带过去；不会重新发送最初的问题。侧栏已有输入或正在回复时，先保留为待接续对话，处理当前内容后再接续。
- **工具栏小窗口**：点击插件图标，查看当前选区。快捷操作直接在侧栏发送，保留已有草稿；正在回复时暂存等待。划词状态与手动启用入口收在「划词工具」中。
- **当前页浮窗状态**：展开工具栏窗口的「划词工具」，查看已安装版本及当前网页是否已加载划词浮窗。普通网页可点击「启用当前页浮窗」或「显示当前页浮窗」；更新后如提示版本不一致，刷新网页再试。
- **右键和快捷键**：选区右键 →「询问 BeingAnywhere」，或按 `Alt+Shift+B`，将内容加入侧栏。快捷键可在 `chrome://extensions/shortcuts` 修改。
- **快捷操作**：聊天小窗、侧栏和工具栏中的「总结」「解释」「翻译」均点击即发送，不填入输入框、不覆盖自定义草稿。工具栏快捷请求先领取再发送，刷新不会重复提交。
- **继续对话**：在侧栏直接追问。当前流结束前，发送按钮禁用；你仍可编辑下一条消息。后续请求使用 Being 返回的 `session_id`。
- **网页引用**：发送前可以移除引用；发出后可展开查看选区和来源。来源去掉 URL 查询参数与片段。插件不自动读取整页。
- **多段内容**：每个浏览器窗口独立暂存最多 10 段待处理选区，已有草稿不会被新选区覆盖。发送或清空当前草稿后可继续加入。
- **同步历史**：↻ 从 Being 读取最近 100 条服务端历史。侧栏显示的是该 Being 的最近历史，可能包含来自桌面或其他入口的消息；不是独立的新 Being。
- **停止接收**：取消本地流式接收。Being 可能仍在处理；可同步历史或打开 Loom 查看。本扩展不会自动重发不确定是否送达的消息。

Chrome 原生侧边栏的位置由浏览器设置控制，可在外观设置中选择右侧。插件无法强制更改用户的侧栏位置。

## 连接与存储

扩展直接调用现有 Loom 的 `/api/status`、`/api/history?limit=100` 和 `/api/chat/stream`，使用 Loom URL 中的 `token`。`api` 参数必须与 Loom 同源。远端仅接受 HTTPS，本机回环地址可使用 HTTP。无需运行额外的桌面桥接服务器。

连接地址保存在扩展的 `chrome.storage.local`，不参与 Chrome 同步，也不向网页内容脚本暴露。该地址可能含令牌；Chrome 扩展本地存储不是操作系统凭据保险库，请在可信的浏览器配置中使用。断开连接会移除连接地址、缓存对话和相应的可选服务访问权限。服务器历史仍由 Being 管理。

草稿、待处理选区、`session_id` 和本地对话视图保存在仅可信扩展页面可读的 `chrome.storage.session`，浏览器会话结束时清除。本地记录用于恢复界面；服务端历史为准。扩展不会读取桌面端保存的凭据，不增加模型设置，也不会改变远端 Being 的工具授权规则。

SSE 在可信扩展来源的浮窗 iframe 或侧栏页面中消费，避免依赖后台 Service Worker 长期存活。网页内容脚本只提交用户明确发送的问题、选区及来源，不接触 Loom 令牌或回复正文。浮窗领取首次请求前先记录状态，刷新不会自动重发。`message_stop` 结束一段回复，整个 HTTP 流结束后才解除发送锁。202 仅表示已接收；接续依据提交前基线、实际用户消息和流游标核对，不把旧回复或其他提问的内容冒充本次回复，也不重新 POST。网络错误、截断流和权限错误显示可操作提示。

## 权限

| 权限 | 用途 |
| --- | --- |
| `sidePanel` | 显示浏览器原生对话侧栏 |
| `contextMenus` | 添加选区右键入口 |
| `activeTab` / `scripting` | 显式操作后读取当前选区，兼容安装前已打开的网页 |
| `storage` | 保存连接、草稿和当前浏览器会话中的聊天视图 |
| HTTP/HTTPS 内容脚本 | 在普通网页中自动显示划词提问条，用户点击发送前不发送文字 |
| 可选服务来源权限 | 用户保存 Loom 地址时，仅申请对应服务的网络访问 |

Chrome 内部页面、应用商店以及部分内置 PDF 页面不能注入内容脚本。跨来源 iframe 的显式选区捕获可能受 activeTab 限制，可使用该 frame 内出现的划词提问条。浮窗忽略输入框、密码框与可编辑表单；工具栏显式捕获允许普通文本/搜索/URL 输入框和 textarea，始终排除密码类型。图片、截图、音视频和文件附件不在本版本范围内；可发送选中的可复制文本、代码与表格文字。

## 开发与验证

在 Being Desktop 项目根目录执行：

```powershell
node --test test/being-anywhere-*.test.cjs
node scripts/verify-being-anywhere.cjs
node scripts/verify-being-anywhere-native-fetch.cjs
node scripts/build-being-anywhere.cjs
```

扩展使用原生 HTML/CSS/JavaScript，无运行时依赖、CDN 和远程执行代码。构建脚本检查语法与资源，输出可解压安装的 ZIP 和 SHA256 至 `.local/being-anywhere-release/`。

离线验证脚本使用隔离 Electron 页面与模拟 Chrome/Loom，输出交互检查、截图和机器可读报告；它不代表真实 Chrome 安装或生产 Being 对话已验证。生产环境不会在测试中接收任何消息。

原生网络验证额外使用未经替换的 Chromium `fetch` 和本机 HTTP 服务，覆盖实际网络调用上下文、连接验证与流式回复，避免网络模拟掩盖浏览器环境问题。

## 协议与实现参考

- 项目中已缓存的官方 Loom 页面 `.local/town-contracts/loom.html`：真实聊天、历史与 SSE 协议依据。
- [Web accessible resources](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources)
- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

品牌图标逐字节复用 Being Desktop 的已确认资源，界面使用 PNG `srcset` 适配显示尺寸与屏幕密度；扩展工具栏与管理页提供 16/32/48/128 px PNG。`icons/being-small.svg` 保留为按 CSS 宽度选择内嵌 PNG 的后备资源。运行 `node scripts/sync-being-anywhere-logo.cjs` 同步已确认的桌面图标，再运行 `node scripts/build-being-anywhere.cjs` 重新打包。项目遵循 MIT License。
