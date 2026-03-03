# SVC FUSE 扩展开发日记：排错与经验总结

**日期**: 2026-03-03
**主题**: VS Code 插件开发 - 打包异常导致的功能失效及交互逻辑优化
**作者**: AI Agent (Antigravity) 协助开发者编写

## 1. 核心踩坑记录： `.vscodeignore` 导致插件环境不完整

### 现象
在安装了自编译的插件包（VSIX）后，发现以下问题：
1. 底部的 **SVC 状态栏无显示**。
2. 尝试调用 `svc.addServer` 等任何命令时，VS Code 抛出 **“command 'svc.addServer' not found”** 错误。

### 原因排查
尽管源码中清晰地注册了相关命令，但实际上这些代码并未被真正执行。问题的根源在于插件的初始化流程在运行前就 **静默崩溃** 了。
通过分析打包流程发现，项目中的 `.vscodeignore` 文件错误地包含了一条剔除规则：
```ignore
node_modules/**
```
这导致由 `vsce package` 构建的插件包中，缺失了所有依赖的 Node.js 库（例如用于建立连接的核心 `ssh2` 和 `ssh2-sftp-client`）。当 VS Code 尝试激活该插件加载相关依赖时，就会因为库缺失而崩溃退出激活流程。这也是为何虽然在 `package.json` 的 `activationEvents` 声明了 `*`（启动激活），但在状态栏里却根本见不到相关图标的原因。

### 经验与教训
在 VS Code 插件开发中，**不要**将 `node_modules/**` 随意写入 `.vscodeignore`，除非你有一个显式的 bundler（如 Webpack 或 esbuild）已经将所有的代码和依赖都打包进了单个 JS 文件（例如 `out/extension.js`）并且在 `package.json` 中的构建脚本完成了这个任务。对于仅仅通过 `tsc` 进行编译的项目，必须依靠运行时的 `node_modules` 提供第三方库。
**解决方案**：去除了 `.vscodeignore` 中针对 `node_modules` 的忽略条件，使得 VSIX 包的大小从约 60KB 增加到了 740KB 左右，插件成功恢复正常。

---

## 2. 交互逻辑优化：零配置下的命令可达性

### 现象
当用户的 `sshConfig` 存在信息，但是当前的 VS Code 插件缓存（`globalState`）里没有任何服务器配置时，系统会优先触发弹窗拦截：
> “没有配置的服务器” [添加服务器]

用户无法看到后续的 QuickPick 菜单，也就无法看到我们精心实现的 **“从 SSH Config 导入”** 这个按钮，被迫强行手动输入。

### 解决方案
重构 `ServerConfigUI.showSelectServerDialog` 的逻辑，去掉了 `servers.length === 0` 时硬编码拦截的 `showInformationMessage`。直接让其始终生成 QuickPick 选项卡。当列表为空时，通过动态修改 QuickPick 的 `placeHolder` 来给与用户提示（如："尚未配置服务器，请选择操作"），这样保证了“手动添加新服务器”与“从 SSH Config 导入”两个核心途径在零状态下的即开即达。

## 3. Package.json 菜单配置纠错

开发中发现在对 view/title 的按钮进行 `menus` 设置时，`explorer/context` 和 `editor/title/context` 错误地放置在了 `menus` 对象外部或者其他错误层级。虽然有时并不引发致命错误，但会导致右键菜单或特定视图图标失效。通过修正 JSON schema 层级，确保所有的菜单扩展都归配在 `"menus": {}` 中予以修正。

---
*总结：一个看似单纯的“找不到命令”，往往暗示着更为底层的插件激活失败。从加载依赖分析到 UI 流程体验优化，我们共同使得 SVC 这个插件愈发完善和健壮。*
