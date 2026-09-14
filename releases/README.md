# 发布约定

- 正式版本统一使用 `X.Y.Z`，标签使用 `vX.Y.Z`，版本号不包含平台名称。
- 安装包使用 `Being-Desktop-<版本>-<平台>-<架构>.<扩展名>`；平台名称为 `macos`、`windows`。
- 每次发布前填写 `releases/<版本>.md`，简要说明用户可感知的更新和下载方式。实现细节、排查过程和测试日志放在开发记录中。
- 使用相同版本的源码分别构建平台安装包，发布后核对文件名、包内版本和 `SHA256SUMS.txt`。

从 0.8.26 开始发布时必须同时提供自动更新清单：

- Windows：`Being-Desktop-X.Y.Z-windows-x64-setup.exe`、对应 `.blockmap` 和 `latest.yml`；便携 EXE 和 ZIP 继续保留。
- macOS：DMG、签名后的 ZIP、对应 `.blockmap` 和 `latest-mac.yml`。保持原应用 ID 与签名身份，禁止将未签名包放入更新源。
- Windows CI 创建草稿 Release。将同一提交构建的 macOS 文件上传到该草稿，合并所有平台的 `SHA256SUMS.txt`，核对清单后再公开发布，避免用户读到尚未齐备的版本。
- 发布前执行 `node scripts/check-desktop-update-artifacts.cjs <产物目录> windows` 和 `node scripts/check-desktop-update-artifacts.cjs <产物目录> mac`，验证版本、文件大小与 SHA512。macOS 多架构应在同一次构建中生成清单（`npm run dist:mac -- --arm64 --x64`），不要用单架构清单相互覆盖。
- 旧版 Desktop 没有更新客户端，需要手动安装一次 0.8.26 或更新版本，之后才可自动检查和下载。真正的升级安装验收需要两份不同版本的签名构建及安装后的应用；单元测试和下载测试不等价于跨版本安装成功。
