# Windows Portal 实机集成验证

2026-09-06（香港时间）已使用官方 **heart-portal v0.8.0 Windows x86_64** 二进制完成一次本机集成验证。测试通过桌面端实际 `PortalService` 管理真实进程，以仅监听 `127.0.0.1` 的受控 WebSocket 中继代替生产 Heart。没有连接生产 Being，没有修改远端 `cz-win`。

## 二进制来源

- [官方 v0.8.0 发布](https://github.com/d5z/heart-portal/releases/tag/v0.8.0)
- 文件：`heart-portal-windows-x86_64.exe`
- 大小：12,193,280 字节
- SHA256：`9f0fb1200d756b5c450cc3ff57752648ab4df70622b82df92033f4167426d355`
- 哈希与 GitHub release asset 的 `digest` 一致；真实 `--version` 输出为 `heart-portal 0.8.0`。
- 启动使用真实 `--config`、`--connect`、`--name` 参数，未通过 shell 启动。

测试二进制、官方源码副本、生成的 TOML、空工作区及机器可读报告位于被 Git 忽略的 `.local/portal-test/`。测试脚本位于 `test/integration/portal-loopback.cjs`，不会随默认单元测试自动运行。

## 实测结果

| 检查 | 实证 |
| --- | --- |
| 真实进程启动 | PID 110904 由 `PortalService` 启动，状态为 `running`、`owned=true`。 |
| 中继握手 | 官方二进制向本机 `/_relay` 发送身份握手，收到测试中继确认后输出真实握手成功日志。 |
| MCP 通路 | 经 WebSocket 返回真实 `initialize` 和 `tools/list` 响应，版本为 0.8.0。 |
| 监听范围 | Windows `Get-NetTCPConnection` 显示一个 `127.0.0.1` 的 Cowork 监听，以及一条目的地址为 `127.0.0.1` 的连接。`Bound` 预留条目单独分类，不当作监听。 |
| 重复实例防护 | 第二个管理器通过原生 Windows 进程查询识别到该 PID，返回 `external`，没有创建新进程。对它执行 `stop` 后原进程仍在运行。 |
| 中继连接丢失 | 测试中继主动关闭连接并暂停监听后，桌面端显示 `health=disconnected`；Portal 进程仍运行。 |
| 自动重新连接 | 中继恢复后，原 PID 重新完成握手和 MCP 元数据请求。 |
| 停止和重新启动 | 停止后原 PID 确认不存在；显式重新启动产生 PID 103288，并再次握手成功。 |
| 拒绝身份握手 | 错误测试令牌被中继拒绝，桌面端显示断开，没有新增 MCP 元数据响应。 |
| 数据边界 | 中继仅发送 `initialize` 和 `tools/list`，没有 `tools/call`；测试工作区仍为空；导出的服务活动不含测试令牌、授权 URL 或命令行。 |
| 清理 | 测试结束后再次查询本机，没有残留 Portal 进程。 |

机器可读记录：`.local/portal-test/integration-result.json`，该次记录开始时间为 `2026-09-05T23:03:13.528Z`，9 个检查点均通过。

## 测试配置与范围

配置使用隔离的空工作区和 kits 目录，禁用 exec、file、screenshot、web_fetch、search、custom_tools 及 kits；Cowork 使用临时测试令牌、`bind=127.0.0.1:0` 和动态 HTTP 端口。中继实现只允许发送 MCP 初始化和工具清单请求，未调用任何命令、文件、OAuth 或其他工具。

这次验证证明真实 Windows Portal 与桌面服务管理器的启停、中继状态、错误握手及重新连接通路工作。它没有验证生产 Heart 的工具调用、权限审批、会话恢复或真实 Being 的业务行为，也没有模拟持续 90 秒的静默心跳黑洞。

Windows 中的 `child.kill('SIGTERM')` 是强制终止。本次没有创建工具子进程，因此不宣称已证明运行中的工具可优雅退出或被完整清理。

## 上游实现限制

以下结论来自固定版本源码，不应与桌面端工作区选择权限混同：

- [v0.8.0 main.rs](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/main.rs) 的 `run_health_server` 硬编码监听 `0.0.0.0`。测试没有使用 `cowork=false` 的该后备路径。
- [v0.8.0 tools/mod.rs](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/mod.rs) 在关闭大部分工具后，仍公布 `portal_oauth_authorize` 和 `portal_tools_reload`，实机清单与源码一致；二者均未调用。
- 同一文件的工具分发对 exec 和 screenshot 有独立禁用检查，但若干 file/search/web 路径不统一检查对应清单开关。因此“未公布某工具”不能视为已建立运行时权限隔离。测试通过可信回环中继只发送元数据请求控制行为，不据此宣称工具能力彻底撤销。

## 重跑

确认没有其他 Portal 实例运行，并将上面指定的官方二进制放到 `.local/portal-test/heart-portal-windows-x86_64.exe`。在项目目录执行：

```powershell
node test/integration/portal-loopback.cjs
```

脚本每次先检查固定 SHA256 和版本，生成临时测试令牌。若检测到已有 Portal，或 Windows 进程查询失败，会终止测试而不干预已有实例。测试的进程和中继均在 `finally` 中清理。
