# Desktop 自动更新

使用 electron-updater 6.8.9，通过构建中固定的 `GuangCZ/BeingDesktop` GitHub Release 配置读取稳定版。生产代码不接受渲染进程传入的更新 URL、路径或安装命令。

先通过 GitHub Release API 读取最新公开稳定版的版本号，再决定是否读取安装清单。本机版本高于发布版时显示「当前版本领先于发布版」，相同时显示已是最新发布版；这两种情况均不需要远端 `latest*.yml`，也不会下载或降级。本机版本较旧时才交由更新库读取清单并校验下载。版本查询失败仍显示失败，不沿用旧的比较结果宣称检查成功。

默认启动后及每小时检查。发现新版后，左下角账户旁、更多菜单前显示下载图标，点击才下载；也可在「设置 → 关于」点击「下载更新」。开关保存在现有加密凭据之外的 `desktopAutoUpdate` 设置字段，默认开启。关闭开关会停止后续自动检查；已经开始的下载会完成。手动检查和点击下载不受开关影响。更新不会自动重启，也不会在普通退出时自动启动 Windows 安装器。

客户端下载后通过 SHA512 校验，在设置页和左下角账户旁显示就绪状态。Windows 使用 NSIS 安装器；便携与目录运行模式显示下载安装版的入口。macOS 使用 ZIP 与 Squirrel.Mac，点击安装后先完成系统签名验证，再沿现有 shutdown 流程保存会话并清理资源。外部 Portal 的所有权与退出行为仍由原有服务管理代码决定。应用不自行覆盖配置、凭据或 Portal 部署。

macOS 原生验证完成后，Squirrel 可能在之后退出时应用已暂存的更新；若后续任务清理阻止重启，不能承诺撤销系统暂存。客户端保留重试状态。代码签名保证仍遵循当前构建模式：本地证书构建必须沿用同一证书，Developer ID 构建必须沿用已固定团队。当前 Windows 构建延续未签名配置，具有 HTTPS 下载与清单摘要验证，尚无发布者证书验证。

开发运行不联网检查，也不替换开发目录。安装包中的 `app-update.yml` 由 electron-builder 生成；macOS 目录构建也会在签名前补齐更新配置。发布流程及必需文件见 `releases/README.md`；缺少更新清单、网络失败、下载校验失败或签名拒绝会显示可重试错误，不宣称已更新。

验证命令：

```sh
npm run check
npm test
npm run test:desktop-updates
# macOS：真实 electron-updater + 本地 HTTP，验证正确摘要与错误摘要，无安装
node test/desktop-updates-download.cjs
```

上线前还需从一份已安装的签名版本升级到更高版本，核对重启后版本、原配置与 Portal 状态；Windows 的 NSIS 安装与重启需在真实 Windows 环境验收。

参考：[electron-builder v26 自动更新文档](https://www.electron.build/v26/docs/features/auto-update/)。
