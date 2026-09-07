# 受限诊断连接器：使用与验证记录

当前状态：启动器与无网络检查已完成。**远端诊断注册仍待用户单独授权，尚未完成生产连接验证。**

本轮 `-Start` 被自动审批拒绝：向现有远端 Being 注册诊断 Portal 需要用户另行明确授权。该次 `CreateProcess` 未执行，没有建立远端注册；没有尝试替代联网方式。

## 已实现的范围

- `Run-LiveFixture.ps1` 提供准备信息、`-Check`、`-Start` 和 `-Stop`。
- `run-live-fixture.cjs` 使用真实 Electron 的 `safeStorage`，从独立副本解锁既有连接。
- 连接器只提供 `diagnostics_roundtrip`，参数必须为 `{}`，结果为固定公开标记 `BEING_TOOL_ROUNDTRIP_OK_V1`。它不提供主机文件、进程、终端或网络请求工具。
- Portal 名称为 `desktop-diagnostics-` 加本轮 UUID 去除横线后的前 12 个十六进制字符，实际名称写入本轮报告。
- 默认时限为 300 秒，可缩短，不能超过 300 秒。停止只处置本轮连接器，不接管已有 Portal，也不使用 PID 文件执行终止命令。

## 凭据与隔离

启动器只接受 `.local/profile` 当前保存的连接，不提供 URL、token 或 relay 地址参数。每次 `-Check` 或 `-Start` 都创建新的 `.local/being-desktop-live-<UUID>`，仅复制 `settings.json` 与 `Local State`；原配置保持不变。

Electron 校验专用目录，核对副本凭据与当前保存凭据一致，再在内存中解密。地址和令牌不会写入命令行、环境变量或诊断报告。Relay 按官方 Loom 链接规则，从保存地址自身的 host 与第一个非空路径段推导。

`control.json` 是本轮本机停止通道的内部控制文件，包含随机停止凭据，不属于诊断导出内容。停止请求需要匹配 UUID、专用命名管道及控制凭据；不会根据文件中的任意 PID 终止进程。

## 使用

在 `E:\CliProxyAPI\being-desktop` 目录运行。以下两条不会连接远端 Being：

```powershell
.\test\integration\Run-LiveFixture.ps1
.\test\integration\Run-LiveFixture.ps1 -Check
```

**只有取得用户对远端诊断注册的单独授权后，才可执行：**

```powershell
.\test\integration\Run-LiveFixture.ps1 -Start -DurationSeconds 300
```

启动返回本轮 `RunId`、Portal 名称和报告路径。使用该轮返回的 UUID 停止：

```powershell
.\test\integration\Run-LiveFixture.ps1 -Stop -RunId '<本轮返回的 UUID>'
```

不得将旧 UUID、其他进程 PID 或原有 Portal 当作本轮停止目标。连接器也会在时限到达时停止。

## 已有证据

JavaScript 静态检查与 PowerShell 语法检查通过。真实 Electron `-Check` 在当前用户上下文执行成功，本轮 UUID：

`f60ed8cf-e87c-48a1-95ec-3487f834e63f`

报告：`.local/being-desktop-live-f60ed8cf-e87c-48a1-95ec-3487f834e63f/check-report.json`。

| 检查 | 结果 |
| --- | --- |
| 独立 profile 目录校验 | true |
| 系统凭据加密可用 | true |
| 副本凭据与当前保存凭据相同 | true |
| 副本可由 safeStorage 解锁 | true |
| 保存连接结构有效 | true |
| WebSocket 构造器存在 | true |
| 固定工具结果符合预期 | true |
| 尝试远端连接 | **false** |

检查后确认原 Being Desktop 进程 `114752` 仍在运行。没有修改主应用或原保存配置。

## 待授权后验证

无网络检查不证明远端握手成功、Being 已发现工具或已收到工具结果。这些项目仍待实际授权连接后验证。

`live-report.json` 仅包含本轮标识、非敏感 Portal 名称、握手状态、请求计数、固定结果摘要及 `lastFixture` 的请求 ID 摘要/处理计数/发送入队状态；不记录请求正文。`responsesSent` 表示本地发送入队，不等于 Being 已确认收讫。`remoteReceiptVerified` 保持 `false`，远端收讫需要 Being 的独立回报佐证。
