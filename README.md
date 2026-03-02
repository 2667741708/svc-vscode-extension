# SVC - VS Code 远程文件系统扩展

[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**SVC** (Server Virtual Connection) 是一个 VS Code 扩展，通过 SFTP 协议将远程服务器的文件系统以虚拟文件夹（`svc://`）的形式直接集成到 VS Code 资源管理器中。

## ✨ 特性

- 🔌 **一键连接** — 通过侧边栏 TreeView 或状态栏快速连接远程服务器
- 📂 **远程文件浏览器** — 可视化浏览远程目录结构，选择要打开的文件夹
- 📝 **原生编辑体验** — 远程文件在 VS Code 中直接打开、编辑、保存，无缝协作
- 🖥️ **SSH 终端** — 内置 SSH 终端管理器，一键打开远程 Shell
- ⚡ **高性能** — 内存级目录缓存（5s TTL），减少 SFTP 往返延迟
- 🔒 **安全连接** — 支持密码和 SSH 私钥认证
- 🌍 **零依赖** — 无需安装任何外部工具（无 FUSE、无 WinFsp），跨平台兼容

## 📦 技术架构

```
用户 → VS Code 扩展 → SFTP 连接池 → svc:// 虚拟文件系统 → VS Code 资源管理器
```

核心组件：

| 组件 | 职责 |
|------|------|
| `SVCFileSystemProvider` | 实现 `vscode.FileSystemProvider`，将 SFTP 操作映射为虚拟文件系统 |
| `SFTPConnectionPool` | 管理 SSH/SFTP 连接池，支持连接复用和并发保护 |
| `ServerTreeView` | 侧边栏服务器列表 UI |
| `ServerConfigUI` | 服务器配置 WebView 面板 |
| `RemoteFolderBrowser` | 远程目录选择器 |
| `SSHTerminalManager` | SSH 终端生命周期管理 |

## 🚀 快速开始

### 开发环境

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 在 VS Code 中按 F5 启动调试
```

### 使用方法

1. 安装扩展后，左侧 Activity Bar 出现 SVC 图标
2. 点击 **"添加服务器"** 配置远程服务器（主机、端口、用户名、密码/私钥）
3. 双击服务器名称 → 浏览远程文件夹 → 选择目标目录
4. 远程文件将以 `svc://` 虚拟文件系统形式出现在资源管理器中
5. 直接编辑文件，保存时自动回写到远程服务器

## 📁 项目结构

```
plugin_fuse/
├── src/
│   ├── extension.ts          # 扩展主入口
│   ├── fileSystemProvider.ts  # svc:// 虚拟文件系统（核心）
│   ├── sftpClient.ts          # SFTP 连接与连接池
│   ├── serverTreeView.ts      # 侧边栏服务器列表
│   ├── serverConfigUI.ts      # 服务器配置 WebView
│   ├── remoteFolderBrowser.ts # 远程文件夹浏览器
│   ├── sshTerminal.ts         # SSH 终端管理器
│   ├── configManager.ts       # 配置管理
│   ├── cacheManager.ts        # 缓存管理
│   └── ignoreParser.ts        # .gitignore 风格过滤
├── package.json               # 扩展清单
├── tsconfig.json              # TypeScript 配置
└── CHANGELOG_修改记录.md      # 变更日志
```

## 🔧 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `svc.autoStart` | boolean | `true` | 自动连接到上次使用的服务器 |

## 📄 License

MIT License - 详见 [LICENSE](LICENSE) 文件。
