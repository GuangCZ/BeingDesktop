# Being Desktop

你的 Being 桌面工作区。连接现有 Loom，在 Windows 或 macOS 中使用对话、项目文件、浏览器、本机终端、Grove 工具和 Portal。

[使用文档](https://GuangCZ.github.io/BeingDesktop/) · [下载](https://github.com/GuangCZ/BeingDesktop/releases) · [English](README.md)

当前源码：**0.8.22-mac.7 · Windows x64 / macOS arm64、x64**。下载附件以 GitHub Releases 为准。需要已有的 Being 与 Loom 连接；身份和记忆仍由原运行时管理。

## 当前功能

- 多会话、图片输入、工具选择与消息定位。
- 本机文件浏览、内置浏览器与持续终端会话（Windows PowerShell / macOS zsh）。
- Portal 一键配置、进程与连接状态、权限管理和更新提示。
- Grove 环境检查、受支持 Kit 的单项与批量安装。
- Town、篝火、围炉与 Channel 入口。
- 分栏设置、主题颜色、阅读字号、Loom 与模型配置。
- 编排模式：Being 拆分和验收任务，外部 CLI Worker 执行，会话下显示状态与工具事件，最终结果回到原会话。

## 编排模式

先选择本机工作区、安装并登录受支持的 Codex CLI、Cursor CLI 或 Grok Build CLI，再进入 **设置 → 编排模式**。Desktop 检测本机 Agent 并连接本机 Worker 工具桥。没有可用 Worker 时不会退回本机直接执行。

每个 Desktop 配置目录有持久 ID，会话、任务与结果路由归属发起它们的 Desktop。同一个 Being 可以连接直接模式的 Mac 和编排模式的 Windows；Worker 使用所在 Desktop 的本机认证、模型地址、代理和工作区。切换模式不修改 Being 的共享模型地址。Being 身份、记忆与服务端运行时仍然共享，Desktop ID 不代表服务端上下文或安全隔离。

旧版若已设置 `/orchestrator/v1` 并继续拦截直接执行，请在模型设置中确认正常模型地址一次；新版不会擅自改写这项共享配置。

Worker 显示在原会话下，可以查看工具调用、日志和执行状态。完成后 Desktop 保存结果并通知 Being；“执行完成”“通知送达”“验收通过”分别记录。Being 的最终摘要、折叠验收依据和“打开预览”按钮呈现在原会话，预览使用 Desktop 内置浏览器。本轮也修复了历史同步重复追加同一 Worker 结果的问题。

Worker 内再次启动 CLI 可能受外层沙箱、登录及网络环境影响。本次牌局的宿主接续已完成验证，但尚未成为 Desktop 通用自动托管能力；Cursor SDK 也尚未接入。

详见[编排模式使用指南](docs/orchestration.html)和[实现说明](docs/orchestration.md)。

首次使用 Desktop 时，输入 Loom 地址后会先读取当前 Being 的身份、创建时间（服务提供时）、模型配置和 Channel 状态，再展示配置概览。已有配置可以继续沿用，也可以选择「直接开始使用」，无需重走全部引导。

创建时间未提供、Channel 授权不足或读取失败时，会显示「未确认」，不会将 Being 当作刚创建或未配置。引导将「24 小时内创建」与是否已有模型或渠道配置分别展示，并区分这台电脑的 Portal 与 Being 的远端 Portal。状态检查只进行读取，不发送聊天消息、不部署软件、不修改渠道。可以重新读取或关闭弹窗后稍后继续。

## 从源码运行

准备 Windows x64 或 macOS、Node.js 24 和 npm。

```powershell
npm ci
npm start
```

## 检查与构建

```powershell
npm run check
npm test
npm run pack
```

目录包位于 `dist/win-unpacked`，请保留整个目录。`npm run dist` 生成便携 EXE。

`npm start` 使用默认用户数据目录；`Start.ps1` 使用相同的默认用户数据目录，共用连接配置。

操作步骤与权限边界见[在线文档](https://GuangCZ.github.io/BeingDesktop/)。源码使用 MIT 许可，第三方资源见 [许可说明](THIRD_PARTY_NOTICES.md)。

## 在 macOS 上构建预览版

准备 Node.js 24、npm、Python 3 和 Xcode Command Line Tools（`xcode-select --install`）。在 Mac 上重新安装依赖，不要复制 Windows 的 `node_modules` 或构建产物。

```sh
npm ci
npm run check
npm test
npm run test:mac
npm run pack:mac
npm run dist:mac
```

- `pack:mac`：生成 `.app` 目录包。
- `dist:mac`：生成 DMG 和 ZIP，输出到 `dist/macos`。
- `dist:mac:arm64`：指定 Apple Silicon 架构。
- `dist:mac:x64`：指定 Intel 架构。

默认使用当前 Node.js 进程的架构。目录包也可通过 `npm run pack:mac -- --arm64` 或 `--x64` 指定架构。建议分别在对应架构的 Mac 上构建和测试；当前输出独立架构包，不是 Universal 包。

`electron-builder.mac.cjs` 复用公共打包设置，并开启 Electron 原生依赖重建。测试分发默认复用钥匙串中的固定本地签名证书，缺少证书会停止构建，不会生成新身份或退回 ad-hoc 签名。DMG 尚未经过 Apple 公证，接收者可能看到开发者验证提示；首次安装与旧版本覆盖升级的钥匙串行为不同，不能保证升级免授权。可选的 `BEING_SIGNING_MODE=developer-id` 模式支持固定 Apple 开发者团队。详见 [macOS 签名说明](docs/macos.md#stable-signing-and-keychain-access)。

此分支已接入官方 macOS Portal 包（arm64 / x86_64），支持按架构校验安装、进程识别、版本更新检查、zsh 终端与控制台、Command 快捷键及 Finder 启动时的 Homebrew 路径发现。已有外部 Portal 会被保留，Desktop 不接管或重复启动它；检测到进程并不代表已验证它连接了当前 Being。

Grove 的已评估安装方案支持 macOS，但仍要求版本、包摘要、运行时和 MCP 检查全部匹配；发布内容变化时会要求重新评估，不会自动运行变化后的代码。详见 [macOS 配套说明](docs/macos.md)。Apple Silicon 版本已在真机完成原生模块、终端和应用启动验证；Intel 选择逻辑有自动化测试，尚未在 Intel Mac 上进行运行验证。
