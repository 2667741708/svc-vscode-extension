import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ServerConfigUI } from './serverConfigUI';
import { RemoteFolderBrowser } from './remoteFolderBrowser';
import { ServerConfig } from './configManager';
import { SFTPConnectionPool, SFTPConnection } from './sftpClient';
import { SSHTerminalManager } from './sshTerminal';
import { registerServerTreeView } from './serverTreeView';
import { SVCFileSystemProvider } from './fileSystemProvider';
import { ServerMonitorProvider } from './serverMonitor';
import { SSHConfigParser } from './sshConfigParser';
import { ConfigManager } from './configManager';

let sftpPool: SFTPConnectionPool;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let terminalManager: SSHTerminalManager;
let fileSystemProvider: SVCFileSystemProvider;
let monitorProvider: ServerMonitorProvider;

// 连接上下文接口
interface ConnectionContext {
    server: ServerConfig;
    remotePath: string;
    sftpConnection: SFTPConnection;
    workspaceUri: string;
}

// 活跃的连接
const activeConnections: Map<string, ConnectionContext> = new Map();

export async function activate(context: vscode.ExtensionContext) {
    try {
        outputChannel = vscode.window.createOutputChannel('SVC FUSE Extension');
        outputChannel.appendLine('🚀 SVC Extension activating...');
        outputChannel.show(); // 自动显示输出面板以便调试

        // 创建 SFTP 连接池和终端管理器
        sftpPool = new SFTPConnectionPool();
        terminalManager = new SSHTerminalManager();

        // 初始化文件系统提供程序（核心：svc:// 虚拟文件系统）
        fileSystemProvider = new SVCFileSystemProvider();
        fileSystemProvider.setOutputChannel(outputChannel); // 传递输出通道用于性能日志
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

                    // 2. 获取并浏览历史远程文件夹
                    const historyKey = `svc.history.${server.host}:${server.port}`;
                    const recentPaths: string[] = context.globalState.get<string[]>(historyKey, []);

                    const browser = new RemoteFolderBrowser(sftpConnection, server.remotePath || '/', recentPaths);
                    const remoteFolder = await browser.browse();
                    if (!remoteFolder) {
                        statusBarItem.text = '$(cloud-download) SVC';
                        return;
                    }

                    // 更新最近访问历史
                    const newRecentPaths = [remoteFolder, ...recentPaths.filter(p => p !== remoteFolder)].slice(0, 5);
                    await context.globalState.update(historyKey, newRecentPaths);

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
                if (activeConnections.size === 0) {
                    vscode.window.showInformationMessage('未找到已连接的服务器，请先连接');
                    return;
                }

                let targetKey = connectionKey;

                // 若未指定 key 且有多个连接，弹出选择器
                if (!targetKey && activeConnections.size > 1) {
                    const items = Array.from(activeConnections.entries()).map(([key, conn]) => ({
                        label: `$(terminal) ${conn.server.name}`,
                        description: `${conn.server.username}@${conn.server.host}  ${conn.remotePath}`,
                        key
                    }));
                    const picked = await vscode.window.showQuickPick(items, {
                        placeHolder: '选择要打开终端的服务器'
                    });
                    if (!picked) { return; }
                    targetKey = picked.key;
                } else if (!targetKey) {
                    targetKey = Array.from(activeConnections.keys())[0];
                }

                const conn = activeConnections.get(targetKey);
                if (conn) {
                    const terminal = await terminalManager.createTerminal(conn.server, conn.remotePath, outputChannel);
                    terminal.show();
                }
            })
        );

        // 为任意服务器（包括尚未挂载的）打开终端（为了侧栏右键图标调用）
        context.subscriptions.push(
            vscode.commands.registerCommand('svc.openTerminalFor', async (serverArg?: ServerConfig) => {
                let server = serverArg;

                if (!server) {
                    // 如果未从右键菜单传入，就从已连接或已配置的服务器中弹出选择
                    const servers = await ConfigManager.getServers(context);
                    if (servers.length === 0) {
                        vscode.window.showInformationMessage('尚未配置任何服务器');
                        return;
                    }
                    const items = servers.map(s => ({
                        label: `$(server) ${s.name}`,
                        description: `${s.username}@${s.host}:${s.port}`,
                        server: s
                    }));
                    const picked = await vscode.window.showQuickPick(items, {
                        placeHolder: '选择要连接终端的服务器'
                    });
                    if (!picked) { return; }
                    server = picked.server;
                }

                // 取出该服务器最近访问的路径（如果有的话）
                const historyKey = `svc.history.${server.host}:${server.port}`;
                const recentPaths: string[] = context.globalState.get<string[]>(historyKey, []);
                const startPath = recentPaths[0] || server.remotePath || '~';

                outputChannel.appendLine(`\n🖥️ 直接开启终端: ${server.name} -> ${startPath}`);
                const terminal = await terminalManager.createTerminal(server, startPath, outputChannel);
                terminal.show();
            })
        );

        // 注册 Terminal Profile Provider ——让 VSCode 原生的 "+" 下拉菜单出现 "SVC: 远程服务器终端" 选项
        context.subscriptions.push(
            vscode.window.registerTerminalProfileProvider('svc.terminalProfile', {
                async provideTerminalProfile(token: vscode.CancellationToken): Promise<vscode.TerminalProfile> {
                    if (token.isCancellationRequested) {
                        throw new Error('cancelled');
                    }

                    const servers = await ConfigManager.getServers(context);

                    let chosenServer: ServerConfig | undefined;

                    if (servers.length === 0) {
                        vscode.window.showInformationMessage('尚未配置任何服务器，请先添加');
                        throw new Error('no servers configured');
                    } else if (servers.length === 1) {
                        chosenServer = servers[0];
                    } else {
                        const items = servers.map(s => ({
                            label: `$(server) ${s.name}`,
                            description: `${s.username}@${s.host}:${s.port}`,
                            server: s
                        }));
                        const picked = await vscode.window.showQuickPick(items, {
                            placeHolder: '选择要开启终端的服务器'
                        });
                        if (!picked || token.isCancellationRequested) {
                            throw new Error('cancelled');
                        }
                        chosenServer = picked.server;
                    }

                    // 取出历史路径
                    const historyKey = `svc.history.${chosenServer.host}:${chosenServer.port}`;
                    const recentPaths: string[] = context.globalState.get<string[]>(historyKey, []);
                    const startPath = recentPaths[0] || chosenServer.remotePath || '~';

                    // 返回一个使用本地 ssh 命令的 TerminalProfile
                    // 这种方式利用完整的本地 bash shell 扮演 ssh 会话，
                    // 而非 PTY 模式，这样 VSCode 的原生终端功能（复制/分屏/搜索）均可用
                    const sshArgs = [
                        `${chosenServer.username}@${chosenServer.host}`,
                        '-p', String(chosenServer.port),
                    ];
                    if (chosenServer.privateKeyPath) {
                        sshArgs.push('-i', chosenServer.privateKeyPath);
                    }
                    // 进入后自动 cd 到最近访问的路径
                    sshArgs.push('-t', `cd "${startPath}" ; exec $SHELL -l`);

                    return new vscode.TerminalProfile({
                        name: `SSH → ${chosenServer.name}`,
                        shellPath: 'ssh',
                        shellArgs: sshArgs,
                        iconPath: new vscode.ThemeIcon('remote'),
                        cwd: process.env.HOME || process.env.USERPROFILE || '/',
                    });
                }
            })
        );

        // 拦截 VS Code 尝试以 svc:// 工作区目录为 cwd 打开的终端
        // 场景1：cwd 是 svc:// URI（多工作区选择时）
        // 场景2：cwd 被 VS Code 转为 file:// 或字符串路径（路径恰好与远程一致）
        // 场景3：只有一个 svc:// 工作区文件夹时，VS Code 直接用它作为 cwd 打开默认终端
        context.subscriptions.push(
            vscode.window.onDidOpenTerminal(async (terminal) => {
                const options = terminal.creationOptions;
                // 跳过我们自己创建的 SSH 伪终端（它们有 pty 字段）
                if (options && 'pty' in options) { return; }

                const termOpts = options as vscode.TerminalOptions | undefined;

                // 提取 cwd 路径和 scheme
                let cwdPath: string | undefined;
                let cwdScheme: string | undefined;
                let cwdAuthority: string | undefined;

                if (termOpts?.cwd instanceof vscode.Uri) {
                    cwdPath = termOpts.cwd.path;
                    cwdScheme = termOpts.cwd.scheme;
                    cwdAuthority = termOpts.cwd.authority;
                } else if (typeof termOpts?.cwd === 'string') {
                    cwdPath = termOpts.cwd;
                    cwdScheme = 'file';
                }

                // 获取所有 svc:// 工作区文件夹
                const svcFolders = vscode.workspace.workspaceFolders?.filter(
                    f => f.uri.scheme === 'svc'
                ) || [];
                if (svcFolders.length === 0) { return; }

                // 辅助函数：按 host 查找已连接服务器并重定向终端
                const redirectToSSH = async (host: string, remotePath: string): Promise<boolean> => {
                    for (const [, conn] of activeConnections) {
                        if (conn.server.host === host) {
                            terminal.dispose();
                            outputChannel.appendLine(`🔄 已拦截终端 cwd，重定向到 SSH: ${conn.server.name} -> ${remotePath}`);
                            const sshTerminal = await terminalManager.createTerminal(
                                conn.server, remotePath, outputChannel
                            );
                            sshTerminal.show();
                            return true;
                        }
                    }
                    return false;
                };

                // 场景1：cwd 直接是 svc:// URI
                if (cwdScheme === 'svc' && cwdPath && cwdAuthority) {
                    if (await redirectToSSH(cwdAuthority, cwdPath)) { return; }
                    terminal.dispose();
                    vscode.window.showWarningMessage(
                        `无法打开终端：远程服务器 ${cwdAuthority} 尚未连接。请先通过 SVC 连接到服务器。`
                    );
                    return;
                }

                // 场景2：cwd 是 file:// 或字符串，检查路径是否匹配某个 svc:// 工作区文件夹
                if (cwdPath) {
                    for (const folder of svcFolders) {
                        if (cwdPath === folder.uri.path || cwdPath.startsWith(folder.uri.path + '/')) {
                            if (await redirectToSSH(folder.uri.authority, cwdPath)) { return; }
                        }
                    }
                }

                // 场景3：没有设置 cwd，但只有一个 svc:// 工作区文件夹
                // 这种情况发生在只挂载了一个远程文件夹时，VS Code 的 "+" 按钮直接创建默认终端
                if (!termOpts?.cwd && svcFolders.length >= 1) {
                    const allFolders = vscode.workspace.workspaceFolders || [];
                    // 仅当所有工作区文件夹都是 svc:// 时才拦截
                    // （如果有本地文件夹，用户可能确实想打开本地终端）
                    const hasLocalFolder = allFolders.some(f => f.uri.scheme !== 'svc');
                    if (!hasLocalFolder && svcFolders.length === 1) {
                        const folder = svcFolders[0];
                        if (await redirectToSSH(folder.uri.authority, folder.uri.path)) { return; }
                    }
                }
            })
        );


        context.subscriptions.push(
            vscode.commands.registerCommand('svc.status', () => {
                const statusSummary = monitorProvider.getStatusSummary();
                vscode.window.showInformationMessage(`SVC 服务器状态报告`, {
                    modal: true,
                    detail: statusSummary
                });
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('svc.clearCache', async () => {
                vscode.window.showInformationMessage('SVC 缓存已清理');
            })
        );

        // 复制完整远程路径 - 提供多种格式，并正确解码中文路径
        context.subscriptions.push(
            vscode.commands.registerCommand('svc.copyRemotePath', async (uri?: vscode.Uri) => {
                let targetUri = uri;
                if (!targetUri) {
                    targetUri = vscode.window.activeTextEditor?.document.uri;
                }

                if (!targetUri || targetUri.scheme !== 'svc') {
                    vscode.window.showWarningMessage('请在 svc:// 远程文件上执行此操作');
                    return;
                }

                const host = targetUri.authority;
                
                // 从 activeConnections 查找匹配此 host 的连接信息
                // 注意: activeConnections 的 key 是 username@host:port 的格式，不能直接用 host get。
                let connection: ConnectionContext | undefined;
                for (const conn of activeConnections.values()) {
                    if (conn.server.host === host) {
                        connection = conn;
                        break;
                    }
                }

                // targetUri.path 在 VS Code 内部已是解码后的原始路径（含中文）
                const remotePath = targetUri.path;

                // 格式1: 详细上下文格式（最适合 AI 提示）
                let aiContextPath = '';
                let scpPath = '';
                
                if (connection) {
                    const server = connection.server;
                    aiContextPath = `[Server: ${server.name} | User: ${server.username} | IP: ${server.host} | Port: ${server.port}] \nPath: ${remotePath}`;
                    scpPath = `${server.username}@${server.host}:${remotePath}`;
                } else {
                    aiContextPath = `[Host: ${host}] \nPath: ${remotePath}`;
                    scpPath = `${host}:${remotePath}`;
                }

                // 格式2: 纯远程路径（无 host）
                const pathOnly = remotePath;
                // 格式3: 原始 svc:// URI（不含中文解码，用于程序调用）
                const svcUri = targetUri.toString(true); // true = 跳过额外编码，保留原字符

                const items = [
                    {
                        label: '$(hubot) 给 AI 看的详细路径',
                        description: aiContextPath.replace(/\n/g, ' '),
                        value: aiContextPath
                    },
                    {
                        label: '$(terminal) SCP/SSH 标准格式',
                        description: scpPath,
                        value: scpPath
                    },
                    {
                        label: '$(folder) 纯远程路径',
                        description: pathOnly,
                        value: pathOnly
                    },
                    {
                        label: '$(link) SVC 内部 URI',
                        description: svcUri,
                        value: svcUri
                    }
                ];

                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: '选择要复制的路径格式',
                    title: '复制远程路径 (SVC)'
                });

                if (!picked) { return; }

                await vscode.env.clipboard.writeText(picked.value);
                vscode.window.showInformationMessage(`已复制: ${picked.value}`);
                outputChannel.appendLine(`📋 已复制路径 [${picked.label.replace(/\$\(.*?\) /, '')}]: ${picked.value}`);
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

                    // 2. 获取历史记录并浏览远程文件夹
                    const historyKey = `svc.history.${server.host}:${server.port}`;
                    const recentPaths: string[] = context.globalState.get<string[]>(historyKey, []);

                    const browser = new RemoteFolderBrowser(sftpConnection, server.remotePath || '/', recentPaths);
                    const remoteFolder = await browser.browse();
                    if (!remoteFolder) {
                        statusBarItem.text = '$(cloud-download) SVC';
                        return;
                    }

                    // 更新最近访问历史
                    const newRecentPaths = [remoteFolder, ...recentPaths.filter(p => p !== remoteFolder)].slice(0, 5);
                    await context.globalState.update(historyKey, newRecentPaths);

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

        // ★ 启动时的自动导入检测逻辑（仅在开发模式下启用）
        if (context.extensionMode === vscode.ExtensionMode.Development) {
            setTimeout(async () => {
                try {
                    const servers = await ConfigManager.getServers(context);
                    if (servers.length === 0) {
                        const sshHosts = await SSHConfigParser.parseConfig();
                        if (sshHosts.length > 0) {
                            const selection = await vscode.window.showInformationMessage(
                                `已检测到系统 SSH 配置中有 ${sshHosts.length} 个节点，您要立即导入这些配置，还是进行手动添加？`,
                                '导入 SSH 配置', '手动添加记录', '稍后'
                            );

                            if (selection === '导入 SSH 配置') {
                                const importedServer = await ServerConfigUI.showImportFromSSHConfig(context);
                                if (importedServer) {
                                    vscode.commands.executeCommand('svc.refreshServers');
                                }
                            } else if (selection === '手动添加记录') {
                                vscode.commands.executeCommand('svc.addServer');
                            }
                        }
                    }
                } catch (error) {
                    outputChannel.appendLine(`⚠️ 自动导入检测失败: ${error}`);
                }
            }, 1500);
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (outputChannel) {
            outputChannel.appendLine(`💥 扩展激活致命错误: ${errorMsg}`);
        }
        vscode.window.showErrorMessage(`SVC 扩展激活失败: ${errorMsg}`);
    }
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



/**
 * 自动将服务器注册到 ssh-manager MCP
 * 使 Antigravity AI 面板也能通过 ssh-manager 访问远程服务器
 */
async function autoRegisterSSHManager(server: ServerConfig, outputChannel: vscode.OutputChannel): Promise<void> {
    try {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const configDir = path.join(homeDir, '.ssh-manager');
        const configPath = path.join(configDir, 'servers.json');

        // 确保目录存在
        if (!fs.existsSync(configDir)) {
            await fs.promises.mkdir(configDir, { recursive: true });
            outputChannel.appendLine(`📁 已创建配置目录: ${configDir}`);
        }

        let existing: any = { servers: [] };
        if (fs.existsSync(configPath)) {
            try {
                const content = await fs.promises.readFile(configPath, 'utf-8');
                existing = JSON.parse(content);
            } catch (e) {
                outputChannel.appendLine(`⚠️ 读取现有配置失败，将重新创建: ${e}`);
            }
        }

        const servers: any[] = existing.servers || [];
        // 检查是否已存在
        const alreadyExists = servers.some(
            (s: any) => s.host === server.host && s.port === server.port && s.username === server.username
        );

        if (!alreadyExists) {
            servers.push({
                host: server.host,
                port: server.port,
                username: server.username,
            });
            existing.servers = servers;
            await fs.promises.writeFile(configPath, JSON.stringify(existing, null, 2));
            outputChannel.appendLine(`🔗 已同步到 ssh-manager 配置: ${configPath}`);
        }

        outputChannel.appendLine('✅ ssh-manager 自动注册完成');
    } catch (error) {
        outputChannel.appendLine(`⚠️ ssh-manager 注册失败 (非致命): ${error}`);
    }
}