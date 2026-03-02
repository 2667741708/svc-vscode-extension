import * as vscode from 'vscode';
import { ConfigManager, ServerConfig } from './configManager';

// 树项类型联合
type TreeItem = ServerTreeItem | ServerDetailItem | EmptyTreeItem;

/**
 * 服务器树视图数据提供者
 */
export class ServerTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (!element) {
            // 根级别：显示所有服务器
            const servers = await ConfigManager.getServers(this.context);

            if (servers.length === 0) {
                return [new EmptyTreeItem()];
            }

            return servers.map(server => new ServerTreeItem(server, this.context));
        } else if (element instanceof ServerTreeItem) {
            // 服务器级别：显示服务器详情
            return [
                new ServerDetailItem('主机', element.server.host, 'server-environment'),
                new ServerDetailItem('端口', element.server.port.toString(), 'symbol-numeric'),
                new ServerDetailItem('用户名', element.server.username, 'account'),
                new ServerDetailItem('认证', element.server.authType === 'password' ? '密码' : '私钥', 'key'),
                new ServerDetailItem('路径', element.server.remotePath || '/', 'folder')
            ];
        }

        return [];
    }
}

/**
 * 服务器树项
 */
class ServerTreeItem extends vscode.TreeItem {
    constructor(
        public readonly server: ServerConfig,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        private context: vscode.ExtensionContext
    ) {
        super(server.name, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = `${server.username}@${server.host}:${server.port}`;
        this.iconPath = new vscode.ThemeIcon('server');
        this.contextValue = 'server';

        this.command = {
            command: 'svc.treeItemClicked',
            title: '连接',
            arguments: [server]
        };
    }
}

/**
 * 服务器详情树项
 */
class ServerDetailItem extends vscode.TreeItem {
    constructor(
        label: string,
        value: string,
        icon: string
    ) {
        super(`${label}: ${value}`, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'serverDetail';
    }
}

/**
 * 空状态树项
 */
class EmptyTreeItem extends vscode.TreeItem {
    constructor() {
        super('未配置服务器', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('info');
        this.description = '点击添加服务器';
        this.command = {
            command: 'svc.addServer',
            title: '添加服务器'
        };
    }
}

/**
 * 注册服务器树视图
 */
export function registerServerTreeView(context: vscode.ExtensionContext): void {
    const treeDataProvider = new ServerTreeDataProvider(context);

    const treeView = vscode.window.createTreeView('svcServers', {
        treeDataProvider,
        showCollapseAll: true
    });

    // 刷新命令
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.refreshServers', () => {
            treeDataProvider.refresh();
        })
    );

    // 树项点击
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.treeItemClicked', async (server: ServerConfig) => {
            // 直接连接到服务器
            vscode.commands.executeCommand('svc.connectToServer', server);
        })
    );

    // 编辑服务器
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.editServer', async (item: ServerTreeItem) => {
            const server = item.server;

            const name = await vscode.window.showInputBox({
                prompt: '服务器名称',
                value: server.name,
                ignoreFocusOut: true
            });
            if (!name) { return; }

            const host = await vscode.window.showInputBox({
                prompt: 'SSH 主机地址',
                value: server.host,
                ignoreFocusOut: true
            });
            if (!host) { return; }

            const portStr = await vscode.window.showInputBox({
                prompt: 'SSH 端口',
                value: server.port.toString(),
                ignoreFocusOut: true
            });
            if (!portStr) { return; }

            const username = await vscode.window.showInputBox({
                prompt: 'SSH 用户名',
                value: server.username,
                ignoreFocusOut: true
            });
            if (!username) { return; }

            const defaultPath = username === 'root' ? '/root' : `/home/${username}`;
            const remotePath = await vscode.window.showInputBox({
                prompt: '远程工作目录',
                value: server.remotePath || defaultPath,
                ignoreFocusOut: true
            });

            const updatedServer: ServerConfig = {
                ...server,
                name,
                host,
                port: parseInt(portStr),
                username,
                remotePath: remotePath || undefined
            };

            await ConfigManager.updateServer(context, updatedServer);
            treeDataProvider.refresh();
            vscode.window.showInformationMessage(`服务器 "${name}" 已更新`);
        })
    );

    // 删除服务器
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.deleteServer', async (item: ServerTreeItem) => {
            const server = item.server;

            const confirm = await vscode.window.showWarningMessage(
                `确定要删除服务器 "${server.name}" 吗？`,
                { modal: true },
                '删除', '取消'
            );

            if (confirm === '删除') {
                await ConfigManager.removeServer(context, server.id);
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`服务器 "${server.name}" 已删除`);
            }
        })
    );

    // 连接到服务器（带服务器参数）
    context.subscriptions.push(
        vscode.commands.registerCommand('svc.connectToServer', async (server: ServerConfig) => {
            // 这会触发连接流程
            vscode.commands.executeCommand('svc.connectWithServer', server);
        })
    );

    context.subscriptions.push(treeView);
}
