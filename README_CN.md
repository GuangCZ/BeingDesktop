# Being Desktop

你的 Being 桌面工作区。连接现有 Loom，在 Windows 中使用对话、项目文件、浏览器、PowerShell、Grove 工具和本机 Portal。

[使用文档](https://GuangCZ.github.io/BeingDesktop/) · [下载](https://github.com/GuangCZ/BeingDesktop/releases) · [English](README.md)

当前版本：**0.8.19 · Windows x64**。需要已有的 Being 与 Loom 连接；身份和记忆仍由原运行时管理。

## 当前功能

- 多会话、图片输入、工具选择与消息定位。
- 本机文件浏览、内置浏览器与持续 PowerShell 会话。
- Portal 一键配置、进程与连接状态、权限管理和更新提示。
- Grove 环境检查、受支持 Kit 的单项与批量安装。
- Town、篝火、围炉与 Channel 入口。
- 分栏设置、主题颜色、阅读字号、Loom 与模型配置。

## 从源码运行

准备 Windows x64、Node.js 24 和 npm。

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

`npm start` 使用默认用户数据目录；`Start.ps1` 使用项目中的 `.local/profile`。二者的连接配置分开。

操作步骤与权限边界见[在线文档](https://GuangCZ.github.io/BeingDesktop/)。源码使用 MIT 许可，第三方资源见 [许可说明](THIRD_PARTY_NOTICES.md)。
