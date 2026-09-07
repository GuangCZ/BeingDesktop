# Portal 最小只读验证：配置与权限审计

审计对象：官方 **heart-portal v0.8.0** 固定版本源码。这里只做源码审查，没有启动生产 Portal、连接生产 Being 或执行工具。

结论：**官方配置无法严格做到“只读取工作区内一个指定文件，并禁止其他能力”。工具清单的开关不能统一充当执行权限检查。**因此不能用 stock Portal 的这些开关直接宣称生产测试已被严格限制为只读。

## 实际执行边界

| 能力 | 调用时是否强制检查配置 | 证据 |
| --- | --- | --- |
| `portal_exec`、`portal_process` | 是，检查 `config.tools.exec`。 | [tools/mod.rs 433–443](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/mod.rs#L433) |
| `portal_screenshot` | 是，检查 `config.tools.screenshot`。 | [tools/mod.rs 449–453](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/mod.rs#L449) |
| 文件读、写、列表、编辑 | 否，直接分发；文件实现也没有检查 `config.tools.file`。 | [tools/mod.rs 445–448](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/mod.rs#L445)、[file.rs](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/file.rs) |
| 搜索 | 否，调用路径不检查 `config.tools.search`。 | [tools/mod.rs 455](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/mod.rs#L455)、[search.rs 13](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/search.rs#L13) |
| 网页抓取、搜索 | 否，直接分发，处理函数不接收配置。 | [tools/mod.rs 456–457](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/mod.rs#L456) |
| OAuth | 否，直接分发并始终公布该工具。 | [tools/mod.rs 379–390、458](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/mod.rs#L379) |
| 自定义工具、kits | 新启动实例可阻止加载，但自定义与 kit 分发优先于内置工具分支。 | [tools/mod.rs 77–81、107–114、417–430](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/mod.rs#L417)、[kits/loader.rs 17–23](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/kits/loader.rs#L17) |

请求入口 [main.rs 652–670](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/main.rs#L652) 对 `tools/call` 调用 `ToolHost::call`，不要求工具出现在 `tools/list`。配置结构 [config.rs 108–130](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/config.rs#L108) 没有单文件白名单、文件只读或 OAuth 禁用项。

[web.rs 103–110](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/web.rs#L103) 会启动 curl；[web_search.rs 150–186](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/web_search.rs#L150) 访问网络搜索服务；[oauth.rs 98–114](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/oauth.rs#L98) 可绑定回调端口、打开系统浏览器并执行 OAuth。它们不能由 `exec=false` 一并禁用。

## 文件路径边界

[file.rs](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/file.rs#L10) 包含工作区约束：

- 接受工作区内绝对路径，处理 `..` 后检查目录前缀。
- 对已存在的文件执行 canonicalize，检查真实路径仍在真实工作区内。
- 写入路径会逐层检查已存在的路径部分。

这些检查用于限定工作区，没有建立“一个文件、只读”的授权。路径验证与随后读取、写入分开进行，没有持有已验证文件句柄，不能据此宣称抵抗并发路径替换。

[search.rs 29–34、79–110](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/tools/search.rs#L79) 对路径做逻辑范围检查，遍历设置了 `follow_links(false)`，但后续 `metadata/read` 会跟随文件链接，并没有统一检查每个文件的真实路径。本轮仅确认源码缺少该检查，**没有执行越界复现**。

此外，[main.rs 736–737](https://github.com/d5z/heart-portal/blob/v0.8.0/portal/src/main.rs#L736) 在关闭 Cowork 后启用的后备健康接口固定绑定 `0.0.0.0`，不会沿用 `bind_host`。先前回环测试使用的是带测试认证且绑定 `127.0.0.1` 的 Cowork，未使用该后备路径。

## 可行的下一步

### 方案 A：独立受限 fixture adapter

用于生产 Heart 的最小只读业务通路验证，且实施范围较小：

1. 在本地创建无敏感信息的指定 fixture，先验证它，再读为固定快照；远端请求不携带可执行文件路径。
2. Adapter 只处理协议所需的初始化、ping、工具清单和一个固定读取工具。其余方法、工具名及不符合固定 schema 的参数全部拒绝。
3. 唯一读取工具返回该 fixture 快照；不能进入 shell、通用文件操作、HTTP、OAuth、自定义工具或 kits 的处理器。
4. 给本次验证使用独立 Portal 名称，保留现有生产实例，先确认 Heart 支持该路由和并存方式。
5. 接生产前用本机中继证明所有拒绝路径，再由真实 Being 发起一次固定读取并回传可核对标记。

此方案应称为“受限 adapter 的 Heart 端到端验证”，它不能证明官方 Portal 的通用文件工具已满足只读隔离。

### 方案 B：受限 Portal 编译版本

如果必须验证官方 Portal 工具调用链，需要新增明确的默认拒绝策略：在 `ToolHost::call` 最前面拦截，先于 custom/kits 和全部内置分发，仅允许固定 fixture 读取；使用预先验证并保持打开的只读文件句柄，不从远端参数重新解析路径。

还需禁用 custom/kits/Cowork 的旁路能力、修正健康接口监听地址，并补充拒绝写入、编辑、列表、搜索、exec/process、截图、网络、OAuth、自定义及 kits 的测试。路径测试应包含绝对路径、`..`、junction/symlink 和并发替换。

只修改 `tools/list`、通过提示词要求不调用、或者设置空命令白名单，均不能代替上述调用入口的限制。本轮不实施或启动任何生产方案。
