# 更改记录 (Changelog)

本文档将详细记录对 `plugin_fuse` 的所有更改，以便长期追踪。

## v0.2.0 (2026-03-02) 技术路径重大切换：FUSE → FileSystemProvider

### 架构变更

彻底放弃 FUSE/WinFsp 本地挂载方案，切换为 VS Code 原生 `FileSystemProvider` API（`svc://` 虚拟文件系统）。

- **[重写] `fileSystemProvider.ts`**：从本地 FUSE 代理模式改为直接 SFTP 驱动模式。所有文件操作（stat/read/write/delete/rename/mkdir）通过 `SFTPConnection` 直接执行远程操作，增加 5 秒 TTL 内存目录缓存。
- **[重写] `extension.ts`**：移除全部 `SidecarClient`、`SyncEngine`、`CacheManager` 引用和 FUSE 挂载逻辑。连接流程简化为 `SFTP → FileSystemProvider → svc:// URI` 三步直通。
- **[删除] `sidecarClient.ts`**：Go Sidecar 的 JSON-RPC 客户端不再需要。
- **[删除] `syncEngine.ts`**：FileSystemProvider 模式下所有读写直接通过 SFTP 执行，无需本地文件同步。
- **[清理] `package.json`**：移除 `svc.sidecarPath` 和 `svc.mountPoint` 配置项。

### 变更原因

经实证验证，WinFsp 在 Windows 环境下存在不可调和的格式冲突（`Z:` vs `Z:\`）：WinFsp `Mount()` 严格拒绝带反斜杠的盘符，而 VS Code `Uri.file()` 严格要求带反斜杠。此外，FUSE 方案依赖外部 C/Go 编译工具链（CGO、GCC），部署成本极高。

### 依赖变化

- 不再需要 WinFsp 安装
- 不再需要 Go 编译环境和 `sidecar.exe`
- 零外部依赖，跨平台天然兼容

---

## v0.1.x (修复阶段)

### 修复问题

- 插件启动后侧边栏显示 `There is no data provider registered that can provide view data.`
- 调用命令时提示 `command 'svc.addServer' not found`

### 更改明细

- **`package.json`**: 将 `activationEvents` 的 `["onStartupFinished"]` 更改为 `["*"]`，以确保在 VS Code 启动及插件界面展示时，相关的 `TreeDataProvider` 能被及时初始化，解决“There is no data provider registered”的报错。
- **`src/extension.ts`**: 补全了之前因重构丢失的关键命令注册：
  - `svc.addServer`：注册服务器添加命令，使其能正确调用新增配置界面。
  - `svc.openTerminal`：注册 SSH 终端开启命令。
  - `svc.status`：注册服务器挂载状态显示命令。
  - `svc.clearCache`：占位了缓存清理的逻辑骨架。

## 2026-02-26 工作记录

- **进度评估**: 对 `TEST_REPORT.md` 中的高优先功能及总体功能与当前仓库代码进行了综合评估。梳理出 FUSE 挂载、SFTP 通信以及配置界面已完成并落地，遗漏项包含文件监听、日志测试等强化工作。
- **文档补充**: 撰写并输出了 `WALKTHROUGH_ZH.md` 报告，在其中以类似模型训练网络的学术方法论拆解方式，严谨标注并拆解分析了当前的卷挂载与 FUSE IO 发送的数据流动链路。
- **工作区文件夹问题修复**: 针对连接后资源管理器出现感叹号及无法打开的问题进行修复，为其加入了重试检测（10秒上限超时探测机制），在物理挂载彻底完毕后再添加至 VS Code 视图，杜绝读空异常。
- **智能添加服务器开发**: 重构了 `ServerConfigUI.ts` 中的手动添加逻辑，引入正则表达式前置输入框，通过一串包含用户名、IP 和端口密码组合的混编字符串直接分解提取关键元数据并传递为变量给下级栏目，提升操作敏捷性。
- **SSH Config 解析器兼容性修复**: 处理了从 `~/.ssh/config` 导入时的前置空白符判定。将原先固守行首匹配（`^`）的正则过滤为支持任意缩进层级及 Tab 制表符的匹配体系。
- **FUSE 虚拟盘异步抢占修复**: 为 `extension.ts` 中的加载逻辑取消了有被锁定风险的 `fs.existsSync()` 的长轮询死循环，转而直接使用了 `setTimeout(1500)` 无前置条件推送到工作区，完全解决了“无法识别盘符”的卡滞死锁问题。

## v0.2.0 (2026-02-26) — 脆弱设计系统性修复

### 核心修复 (6 项)

- **F1** `sidecarClient.ts`: 修复 `sendRequest` 超时定时器泄漏 (`clearTimeout` + 进程退出全量清理)；`start()` 增加提前失败检测
- **F2** `sftpClient.ts`: 修复连接池并发竞争 (引入 `pendingConnections` Promise 合并)；修复 `exists()` 始终返回 true 的逻辑 bug
- **F3** `syncEngine.ts`: 替换 `isSyncing` 单锁为异步队列模式 (`pendingOps` Map + `drainPendingOps`)
- **F4** `extension.ts`: sidecar 缺失不再阻断命令注册 (懒检查模式)；注册缺失的 `svc.connectWithServer` 命令
- **F5** `fileSystemProvider.ts`: 全部同步 IO (`statSync`/`readFileSync` 等) 替换为 `fs.promises` 异步版本
- **F6** `sshTerminal.ts`: 修复 PTY 实例复用 bug (添加 `isAlive` 存活检查)

### TEST_REPORT 功能对齐

- **`package.json`**: 新增 `svc.sidecarPath` 和 `svc.mountPoint` 配置项
- **`serverConfigUI.ts`**: 修复 ESLint `no-useless-escape` 正则转义错误

### 验证结果

- TypeScript 编译: 0 错误
- ESLint: 0 错误 0 警告

## 2026-03-01 紧急挂载问题修复

- **[修复] `mountPath` 硬编码与本地空文件夹挂载超时异常**:
  - 发现 `svc.connectWithServer` (TreeView 绑定命令) 中存在 `mountPath` 被硬编码为 `Z:\` 的漏洞，导致 `package.json` 中的 `svc.mountPoint` 设置被绕过失效。
  - 为 `extension.ts` 中的 `svc.connectWithServer` 和 `svc.connect` 补全了对于 `vscode.workspace.getConfiguration('svc').get<string>('mountPoint')` 的读取。
  - 在发起 `sidecarClient.mount(mountPath)` 前加入了判断逻辑：如果挂载地址是具体的本地文件夹而非盘符（如长度大于3），则自动判断并在需时调用 `fs.mkdirSync(mountPath, { recursive: true })` 进行创建。这完全避免了 WinFsp 因为目标文件夹不存在而导致挂载过程卡死报错（超时不响应）的核心痛点。

- **[撤回修复] 画蛇添足的根目录 CWD 加载失败问题 (`Z:\`)**:
  - 在早前测试时，为了规避所谓的格式问题我曾错误地强行移除了用户配置中盘符的尾随反斜线（`Z:\` -> `Z:`）传递给 WinFsp，虽底层挂载挂载，但却导致 VS Code 认为工作区根目录不存在（报 `Starting directory (cwd) Z:\ does not exist`）。
  - 全面撤回了该错误逻辑！现在恢复了正确的单向传导路径：保证 `mountPath` 始终遵循 `EndsWith("\\")` 追加后置斜杠成为原生的驱动器级别根目录 `Z:\`，这确保了无论是 FUSE 的系统注册，还是 VS Code 的 `Workspace Folder` 解析或内部伪终端启动，都能对统一标准的绝对路径准确识别，完美杜绝挂载假死。
