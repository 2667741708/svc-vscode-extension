# 错误解决表 (Error Resolution Table)

| 时间 | 错误现象 / 报错信息 | 原因分析 | 解决方案 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| 2026-02-26 | `There is no data provider registered that can provide view data.` | 插件尚未完全激活，由于 `package.json` 的 `activationEvents` 延后到了 `["onStartupFinished"]`。导致在获取展示面板数据时未找到 Provide 实例 | 修改 `package.json` 的 `activationEvents` 为 `["*"]` ，在启动时即可注册激活 | ✅ 解决 |
| 2026-02-26 | `command 'svc.addServer' not found` | 在重构代码时丢失了 `extension.ts` 中的一系列命令的注册逻辑 | 修改 `src/extension.ts` ，补充这些命令注册 | ✅ 解决 |
| 2026-02-26 | `listen EADDRINUSE: address already in use 0.0.0.0:3001` <br> `[Backend] 进程异常退出` | 后端服务（如 Node.js http 服务器）在扩展/调试停止时没有被正确关闭（Zombie Process），导致端口被持续占用。重新调试时无法再次绑定 3001 端口。 | **临时修复**：通过命令 `netstat -ano \| findstr 3001` 找出 PID 然后 `taskkill /PID <pid> /F` 关闭。<br>**代码级修复**：在启动后端服务的扩展的 `deactivate()` 方法中，必须显式调用 `childProcess.kill()` 关闭进程。 | ✅ 解决 |
| 2026-02-26 | 成功连接且启动控制台无报错后，左侧资源管理器的加载项前存在 `!` 甚至提示“无法打开不存在的文件夹” | FUSE 调用返回成功后，在 Windows 系统级注册盘符、初始化文件 IO 接口存在几十甚至数百毫秒的软延迟。此时立马将卷写入 VS Code Workspace 时路径实质尚不存在，引起读取抛错。 | （第一次尝试）在写入 `vscode.workspace.updateWorkspaceFolders` 之前，设定一个循环间隔器 `fs.existsSync`。<br>（第二次修正）废弃 `existsSync`，由于 FUSE 挂载期的锁定权限可能阻拦 Node 判断，改为无脑 `setTimeout` 延迟 1.5 秒后强行推送 Workspace 交由 VS Code 自动监听加载。 | ✅ 解决 |
| 2026-02-26 | 选择 ”从 SSH Config 导入“ 时无法识别或遗漏配置 | 原本 `SSHConfigParser.ts` 采用高度严格的正则表达式（例如 `^HostName\s+` 必须定界行首），导致其遇到用户采用 Tab 制表符作为缩进或带有前导空格的配置便直接被判定失效跳过。 | 去除正则强制行首匹配（`^` 符号改为 `/HostName\s+(.+)$/i` 等），使其具有容忍前置任意制表及空格的泛匹配能力。 | ✅ 解决 |

| 2026-02-26 | **[F1]** `SidecarClient.sendRequest` 超时定时器泄漏 | `setTimeout(30000)` 在请求正常完成时不会被清除，导致定时器堆积 | 保存 `timeoutId`，在 `handleResponse` 处 `clearTimeout`；进程退出时全量清理 | 已解决 |
| 2026-02-26 | **[F2]** `SFTPConnectionPool.getConnection` 并发竞争 | 两个并发调用同时看到 `!isConnected()` → 各自创建连接 → 连接泄漏 | 引入 `pendingConnections` Map 实现 Promise 请求合并 | 已解决 |
| 2026-02-26 | **[F2]** `SFTPConnection.exists()` 始终返回 true | `ssh2-sftp-client.exists()` 返回 `false` 或字符串（不抛异常），原代码逻辑错误 | 改为检查返回值 `result !== false` | 已解决 |
| 2026-02-26 | **[F3]** `SyncEngine` isSyncing 单锁导致事件丢弃 | `performSync` 中 isSyncing 时递归 `scheduleSync` 可能无限循环 | 改为异步队列模式：`pendingOps Map` + `drainPendingOps` | 已解决 |
| 2026-02-26 | **[F4]** `extension.ts` sidecar 缺失阻断全部功能 | sidecar 不存在时直接 return → 所有命令注册被跳过 | 改为 `sidecarAvailable` 标志 + 懒检查，命令无条件注册 | 已解决 |
| 2026-02-26 | **[F4]** `svc.connectWithServer` 命令未注册 | `serverTreeView.ts` 调用该命令但从未注册 | 在 `extension.ts` 中注册并实现完整连接流程 | 已解决 |
| 2026-02-26 | **[F5]** `fileSystemProvider.ts` 同步 IO 阻塞 | `statSync`/`readFileSync` 等阻塞扩展宿主进程 | 全部替换为 `fs.promises` 异步版本 | 已解决 |
| 2026-02-26 | **[F6]** SSH 终端 PTY 复用 bug | 旧 PTY 已关闭但仍被复用 → 新 Terminal 绑定死 PTY | 添加 `isAlive` 属性，已死实例自动替换 | 已解决 |
| 2026-02-26 | **[ESLint]** 正则转义 + 编码损坏 | regex `\.` 不必要转义 + PowerShell 改变编码 | 以 UTF-8 重新创建文件并修正正则 | 已解决 |
| 2026-03-01 | **[挂载]** “无法挂载远程服务器到我本地文件夹” / `mountPath` 硬编码错误 | 在 `svc.connectWithServer` 流程中（通过树视图点击触发），`mountPath` 被硬编码为了 `Z:\`，忽略了用户通过 `mountPoint` 设置的自定义挂载路径；另外如果用户设定的挂载路径是本地特定的空文件夹，该文件夹如果未被提前建立，WinFsp 进行挂载时将会报错或超时不响应。 | 在 `extension.ts` 中修正了 `mountPath` 的取值逻辑，统一从配置读取。同时加入了自动检测，如果挂载目标是具体的本地文件夹而不是单一的驱动器盘符（如长度大于3），则自动调用 `fs.mkdirSync(mountPath, { recursive: true })` 进行创建。 | ✅ 已解决 |
