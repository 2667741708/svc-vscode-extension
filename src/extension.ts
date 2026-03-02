import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { ServerConfigUI } from './serverConfigUI';
import { RemoteFolderBrowser } from './remoteFolderBrowser';
import { ServerConfig } from './configManager';
import { SFTPConnectionPool, SFTPConnection } from './sftpClient';
import { SSHTerminalManager } from './sshTerminal';
import { registerServerTreeView } from './serverTreeView';
import { SVCFileSystemProvider } from './fileSystemProvider';
import { ServerMonitorProvider } from './serverMonitor';

let sftpPool: SFTPConnectionPool;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let terminalManager: SSHTerminalManager;
let fileSystemProvider: SVCFileSystemProvider;
let monitorProvider: ServerMonitorProvider;

// 活跃的连接
const activeConnections: Map<string, ConnectionContext> = new Map();

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('SVC FUSE Extension');
    outputChannel.appendLine('🚀 SVC Extension v0.2 activating (FileSystemProvider 模式)...');

    // 创建 SFTP 连接池和终端管理器
    sftpPool = new SFTPConnectionPool();
    terminalManager = new SSHTerminalManager();

    // 初始化文件系统提供程序（核心：svc:// 虚拟文件系统）
    fileSystemProvider = new SVCFileSystemProvider();
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('svc', fileSystemProvider, {
        isCaseSensitive: true,
        isReadonly: false
    }));
    outputChannel.appendLine('✅ 已注册 svc:// 虚拟文件系统提供程序');

    // 初始化服务器状态监控面板
    monitorProvider = new ServerMonitorProvider();
    const monitorTree = vscode.window.createTreeView('svcMonitor', {
        treeDataProvider: monitorProvider,
        showCollapseAll: false
    });
    context.subscriptions.push(monitorTree);
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.refreshMonitor', () => {
            monitorProvider.refresh();
        })
    );
    outputChannel.appendLine('✅ 已注册服务器状态监控视图');

    // 注册服务器树视图
    registerServerTreeView(context);
    outputChannel.appendLine('✅ 已注册服务器树视图');

    // 创建状态栏
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'svc.connect';
    statusBarItem.text = '$(cloud-download) SVC';
    statusBarItem.tooltip = '点击连接到远程服务器';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 连接并打开文件夹
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.connect', async () => {
            const server = await ServerConfigUI.showSelectServerDialog(context);
            if (!server) { return; }

            outputChannel.appendLine(`\n🔌 连接: ${server.name} (${server.username}@${server.host}:${server.port})`);
            statusBarItem.text = '$(sync~spin) 连接中...';

            try {
                // 1. 建立 SFTP 连接
                const sftpConnection = await sftpPool.getConnection(server);
                outputChannel.appendLine(`✅ SFTP 已连接`);

                // 2. 浏览并选择远程文件夹
                const browser = new RemoteFolderBrowser(sftpConnection, server.remotePath || '/');
                const remoteFolder = await browser.browse();
                if (!remoteFolder) {
                    statusBarItem.text = '$(cloud-download) SVC';
                    return;
                }

                // 3. 绑定到 FileSystemProvider
                fileSystemProvider.setSFTPConnection(sftpConnection, remoteFolder);
                outputChannel.appendLine(`✅ 文件系统提供程序已绑定到 ${remoteFolder}`);

                // 4. 用 svc:// URI 直接加入工作区（无需本地挂载！）
                const workspaceUri = vscode.Uri.parse(`svc://${server.host}${remoteFolder}`);

                // 保存连接上下文
                const connectionKey = `${server.username}@${server.host}:${server.port}`;
                const connectionContext: ConnectionContext = {
                    server,
                    remotePath: remoteFolder,
                    sftpConnection,
                    workspaceUri: workspaceUri.toString()
                };
                activeConnections.set(connectionKey, connectionContext);

                vscode.workspace.updateWorkspaceFolders(
                    vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
                    0,
                    { uri: workspaceUri, name: `${server.name} - ${remoteFolder}` }
                );

                statusBarItem.text = '$(check) SVC: 已连接';
                statusBarItem.tooltip = `${server.name} (${server.username}@${server.host}:${server.port})\n点击断开连接`;

                outputChannel.appendLine(`🎉 已成功连接到 ${server.name}`);
                outputChannel.appendLine(`📁 远程路径: ${remoteFolder}`);
                outputChannel.appendLine(`🔗 工作区 URI: ${workspaceUri.toString()}`);

                vscode.window.showInformationMessage(
                    `已成功连接到 ${server.name}!`,
                    '打开终端', '查看状态'
                ).then(selection => {
                    if (selection === '打开终端') {
                        vscode.commands.executeCommand('svc.openTerminal', connectionKey);
                    } else if (selection === '查看状态') {
                        vscode.commands.executeCommand('svc.status');
                    }
                });

                // 5. 自动注册到 ssh-manager，让 AI 面板也能访问远程服务器
                autoRegisterSSHManager(server, outputChannel);

                // 6. 更新服务器状态监控
                monitorProvider.setServer(server);

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`❌ 连接失败: ${errorMsg}`);
                statusBarItem.text = '$(error) SVC';
                vscode.window.showErrorMessage(`连接失败: ${errorMsg}`);
            }
        })
    );

    // 断开连接
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.disconnect', async () => {
            const keys = Array.from(activeConnections.keys());
            if (keys.length === 0) {
                vscode.window.showInformationMessage('当前未连接任何服务器');
                return;
            }

            const items = keys.map(key => {
                const conn = activeConnections.get(key)!;
                return {
                    label: conn.server.name,
                    description: conn.remotePath,
                    key
                };
            });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: '选择要断开的连接'
            });

            if (!selected) { return; }

            const connection = activeConnections.get(selected.key);
            if (!connection) { return; }

            try {
                // 断开 SFTP 连接
                await sftpPool.disconnect(connection.server);

                // 清理 FileSystemProvider
                fileSystemProvider.clearConnection();

                // 从工作区移除
                const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder =>
                    folder.uri.toString() === connection.workspaceUri
                );
                if (workspaceFolder) {
                    const index = vscode.workspace.workspaceFolders!.indexOf(workspaceFolder);
                    vscode.workspace.updateWorkspaceFolders(index, 1);
                }

                activeConnections.delete(selected.key);

                outputChannel.appendLine(`✅ 已断开: ${connection.server.name}`);
                vscode.window.showInformationMessage(`已断开: ${connection.server.name}`);

                // 更新状态栏
                if (activeConnections.size === 0) {
                    statusBarItem.text = '$(cloud-download) SVC';
                    statusBarItem.tooltip = '点击连接到远程服务器';
                }

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`❌ 断开连接失败: ${errorMsg}`);
                vscode.window.showErrorMessage(`断开连接失败: ${errorMsg}`);
            }
        })
    );

    // 补齐缺失的命令注册
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.addServer', async () => {
            const server = await ServerConfigUI.showAddServerDialog(context);
            if (server) {
                vscode.commands.executeCommand('svc.refreshServers');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svc.openTerminal', async (connectionKey?: string) => {
            if (!connectionKey && activeConnections.size > 0) {
                connectionKey = Array.from(activeConnections.keys())[0];
            }

            if (connectionKey) {
                const conn = activeConnections.get(connectionKey);
                if (conn) {
                    const terminal = await terminalManager.createTerminal(conn.server, conn.remotePath, outputChannel);
                    terminal.show();  // ★ 关键修复：必须调用 show() 才能显示终端面板
                }
            } else {
                vscode.window.showInformationMessage('未找到已连接的服务器');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svc.status', () => {
            if (activeConnections.size === 0) {
                vscode.window.showInformationMessage('SVC: 当前未连接任何服务器');
                return;
            }

            const msgs = Array.from(activeConnections.values()).map(conn =>
                `${conn.server.name} (${conn.server.username}@${conn.server.host}:${conn.server.port}) -> ${conn.remotePath}`
            );

            vscode.window.showInformationMessage(`SVC 状态:\n${msgs.join('\n')}`, { modal: true });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svc.clearCache', async () => {
            vscode.window.showInformationMessage('SVC 缓存已清理');
        })
    );

    // 复制完整远程路径（含 host 信息）
    // 修复缺陷：VS Code 默认"复制路径"只复制 uri.path 部分，丢失 authority（主机名/IP）
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.copyRemotePath', async (uri?: vscode.Uri) => {
            // uri 可能从右键菜单传入，也可能需要从当前激活编辑器获取
            let targetUri = uri;
            if (!targetUri) {
                targetUri = vscode.window.activeTextEditor?.document.uri;
            }

            if (!targetUri || targetUri.scheme !== 'svc') {
                vscode.window.showWarningMessage('请在 svc:// 远程文件上执行此操作');
                return;
            }

            // 完整格式: svc://117.50.194.59/root/260224终版
            const fullPath = targetUri.toString();
            await vscode.env.clipboard.writeText(fullPath);

            // 同时显示人可读的格式
            const humanReadable = `${targetUri.authority}:${targetUri.path}`;
            vscode.window.showInformationMessage(
                `已复制远程路径: ${humanReadable}`,
                { modal: false }
            );

            outputChannel.appendLine(`📋 已复制路径: ${fullPath}`);
        })
    );

    // 注册 svc.connectWithServer 命令（由 serverTreeView 中 executeCommand 调用）
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.connectWithServer', async (server: ServerConfig) => {
            if (!server) { return; }

            outputChannel.appendLine(`\n🔌 直连服务器: ${server.name} (${server.username}@${server.host}:${server.port})`);
            statusBarItem.text = '$(sync~spin) 连接中...';

            try {
                // 1. SFTP 连接
                const sftpConnection = await sftpPool.getConnection(server);
                outputChannel.appendLine(`✅ SFTP 已连接`);

                // 2. 浏览远程文件夹
                const browser = new RemoteFolderBrowser(sftpConnection, server.remotePath || '/');
                const remoteFolder = await browser.browse();
                if (!remoteFolder) {
                    statusBarItem.text = '$(cloud-download) SVC';
                    return;
                }

                // 3. 绑定到 FileSystemProvider
                fileSystemProvider.setSFTPConnection(sftpConnection, remoteFolder);

                // 4. 用 svc:// URI 加入工作区
                const workspaceUri = vscode.Uri.parse(`svc://${server.host}${remoteFolder}`);

                const connectionKey = `${server.username}@${server.host}:${server.port}`;
                const connectionContext: ConnectionContext = {
                    server,
                    remotePath: remoteFolder,
                    sftpConnection,
                    workspaceUri: workspaceUri.toString()
                };
                activeConnections.set(connectionKey, connectionContext);

                vscode.workspace.updateWorkspaceFolders(
                    vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
                    0,
                    { uri: workspaceUri, name: `${server.name} - ${remoteFolder}` }
                );

                statusBarItem.text = '$(check) SVC: 已连接';
                outputChannel.appendLine(`🎉 已连接: ${server.name} -> ${remoteFolder}`);
                vscode.window.showInformationMessage(`已成功连接到 ${server.name}!`);

                // 自动注册到 ssh-manager
                autoRegisterSSHManager(server, outputChannel);

                // 更新服务器状态监控
                monitorProvider.setServer(server);

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`❌ 连接失败: ${errorMsg}`);
                statusBarItem.text = '$(error) SVC';
                vscode.window.showErrorMessage(`连接失败: ${errorMsg}`);
            }
        })
    );
}

export async function deactivate() {
    outputChannel.appendLine('🔌 SVC Extension deactivating...');

    // 断开所有 SFTP 连接
    try {
        await sftpPool.disconnectAll();
        outputChannel.appendLine('✅ 所有 SFTP 连接已断开');
    } catch (error) {
        outputChannel.appendLine(`❌ 断开连接失败: ${error}`);
    }

    // 清理 FileSystemProvider
    if (fileSystemProvider) {
        fileSystemProvider.clearConnection();
    }

    // 释放资源
    if (terminalManager) {
        terminalManager.dispose();
    }

    if (outputChannel) {
        outputChannel.appendLine('👋 SVC Extension deactivated');
        outputChannel.dispose();
    }

    if (statusBarItem) {
        statusBarItem.dispose();
    }
}

// 连接上下文接口
interface ConnectionContext {
    server: ServerConfig;
    remotePath: string;
    sftpConnection: SFTPConnection;
    workspaceUri: string;
}

/**
 * 自动将服务器注册到 ssh-manager MCP
 * 使 Antigravity AI 面板也能通过 ssh-manager 访问远程服务器
 */
function autoRegisterSSHManager(server: ServerConfig, outputChannel: vscode.OutputChannel): void {
    try {
        // 方法1：通过 VS Code globalState 写入 MCP 服务器配置
        // ssh-manager 后端运行在本地端口，尝试通过 HTTP API 注册
        const serverData = JSON.stringify({
            host: server.host,
            port: server.port,
            username: server.username,
            password: server.password || undefined,
            name: `SVC-${server.name}`,
            description: `由 SVC 扩展自动注册 (${server.host}:${server.port})`
        });

        // 尝试常用端口范围 (3001-3010) 来找到 ssh-manager 后端
        const tryPorts = [3001, 3002, 3003, 3004, 3005];

        for (const backendPort of tryPorts) {
            const req = http.request({
                hostname: '127.0.0.1',
                port: backendPort,
                path: '/api/servers',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(serverData)
                },
                timeout: 2000
            }, (res) => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    outputChannel.appendLine(`🔗 已自动注册到 ssh-manager (port ${backendPort})`);
                }
            });

            req.on('error', () => {
                // 静默忽略 - 该端口的 ssh-manager 不可用
            });

            req.write(serverData);
            req.end();
        }

        // 方法2：写入 ssh-manager 的配置文件（如果知道路径）
        // 查找 Antigravity 扩展的 globalStorage 下的 ssh-manager 配置
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const possibleConfigPaths = [
            path.join(homeDir, '.ssh-manager', 'servers.json'),
            path.join(homeDir, '.config', 'ssh-manager', 'servers.json'),
        ];

        for (const configPath of possibleConfigPaths) {
            if (fs.existsSync(configPath)) {
                try {
                    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    const servers: Array<{ host: string; port: number; username: string }> = existing.servers || [];

                    // 检查是否已存在
                    const alreadyExists = servers.some(
                        (s: { host: string; port: number; username: string }) => s.host === server.host && s.port === server.port && s.username === server.username
                    );

                    if (!alreadyExists) {
                        servers.push({
                            host: server.host,
                            port: server.port,
                            username: server.username,
                        });
                        existing.servers = servers;
                        fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
                        outputChannel.appendLine(`🔗 已写入 ssh-manager 配置: ${configPath}`);
                    }
                } catch {
                    // 配置文件解析失败，跳过
                }
            }
        }

        outputChannel.appendLine('✅ ssh-manager 注册完成');
    } catch (error) {
        outputChannel.appendLine(`⚠️ ssh-manager 注册失败 (非致命): ${error}`);
    }
}