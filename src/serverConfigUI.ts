import * as vscode from 'vscode';
import { ConfigManager, ServerConfig } from './configManager';
import { SSHConfigParser } from './sshConfigParser';

export class ServerConfigUI {
    static async showAddServerDialog(context: vscode.ExtensionContext): Promise<ServerConfig | undefined> {
        // 第一阶段：智能解析
        const smartString = await vscode.window.showInputBox({
            prompt: '智能解析（可选）',
            placeHolder: '例如: root@192.168.1.100 -p 22 password 或直接回车跳过',
            ignoreFocusOut: true,
        });

        // 解析参数结果字典
        let parsedHost = '';
        let parsedUsername = '';
        let parsedPort = '';
        let parsedPassword = '';

        if (smartString && smartString.trim()) {
            const str = smartString.trim();
            // 第一步：解析 host 和 username
            // 匹配 username@host 结构，如 root@192.168.1.100 或 u@my.host.com
            const userHostMatch = str.match(/([a-zA-Z0-9_\-.]+)@([a-zA-Z0-9_\-.]+)/);
            if (userHostMatch) {
                parsedUsername = userHostMatch[1];
                parsedHost = userHostMatch[2];
            } else {
                // 退步找 IP 或简单 host
                const hostMatch = str.match(/(?:[0-9]{1,3}\.){3}[0-9]{1,3}|(?:\b[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+\b)/);
                if (hostMatch) {
                    parsedHost = hostMatch[0];
                }
            }

            // 第二步：解析端口 port
            const portMatch = str.match(/(?:-p|-P|port)\s*(\d{1,5})/i);
            if (portMatch) {
                parsedPort = portMatch[1];
            }

            // 第三步：提取可能剩下的单词作为密码
            let remainStr = str;
            if (userHostMatch) { remainStr = remainStr.replace(userHostMatch[0], ''); }
            else if (parsedHost) { remainStr = remainStr.replace(parsedHost, ''); }
            if (portMatch) { remainStr = remainStr.replace(portMatch[0], ''); }

            remainStr = remainStr.trim();
            if (remainStr && !/\s/.test(remainStr)) {
                parsedPassword = remainStr;
            }
        }

        // 第二阶段：逐个字段确认

        const name = parsedHost ? parsedHost : await vscode.window.showInputBox({
            prompt: '服务器名称',
            placeHolder: '例如: 训练服务器',
            ignoreFocusOut: true,
            validateInput: (value) => {
                return value.trim() ? null : '服务器名称不能为空';
            }
        });
        if (!name) { return undefined; }

        const host = parsedHost ? parsedHost : await vscode.window.showInputBox({
            prompt: 'SSH 主机地址',
            placeHolder: '例如: 192.168.1.100 或 server.example.com',
            ignoreFocusOut: true,
            validateInput: (value) => {
                return value.trim() ? null : '主机地址不能为空';
            }
        });
        if (!host) { return undefined; }

        const portStr = parsedPort ? parsedPort : await vscode.window.showInputBox({
            prompt: 'SSH 端口',
            value: '22',
            ignoreFocusOut: true,
            validateInput: (value) => {
                const port = parseInt(value);
                return (!isNaN(port) && port > 0 && port < 65536) ? null : '请输入有效的端口号 (1-65535)';
            }
        });
        if (!portStr) { return undefined; }
        const port = parseInt(portStr);

        const username = parsedUsername ? parsedUsername : await vscode.window.showInputBox({
            prompt: 'SSH 用户名',
            placeHolder: '例如: root, ubuntu',
            ignoreFocusOut: true,
            validateInput: (value) => {
                return value.trim() ? null : '用户名不能为空';
            }
        });
        if (!username) { return undefined; }

        let authType: { value: 'password' | 'privateKey', label?: string } | undefined;
        if (parsedPassword) {
            authType = { value: 'password' };
        } else {
            authType = await vscode.window.showQuickPick(
                [
                    { label: '密码认证', value: 'password' as const },
                    { label: '私钥认证', value: 'privateKey' as const }
                ],
                { placeHolder: '选择认证方式', ignoreFocusOut: true }
            );
        }
        if (!authType) { return undefined; }

        let password: string | undefined;
        let privateKeyPath: string | undefined;

        if (authType.value === 'password') {
            password = parsedPassword ? parsedPassword : await vscode.window.showInputBox({
                prompt: 'SSH 密码',
                password: true,
                ignoreFocusOut: true,
                validateInput: (value) => {
                    return value ? null : '密码不能为空';
                }
            });
            if (!password) { return undefined; }
        } else {
            const keyPath = await vscode.window.showInputBox({
                prompt: '私钥文件路径',
                placeHolder: '例如: C:\\Users\\YourName\\.ssh\\id_rsa 或 ~/.ssh/id_rsa',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    return value.trim() ? null : '私钥路径不能为空';
                }
            });
            if (!keyPath) { return undefined; }
            privateKeyPath = keyPath;
        }

        const defaultPath = username === 'root' ? '/root' : `/home/${username}`;
        const remotePath = await vscode.window.showInputBox({
            prompt: '远程工作目录（可选）',
            placeHolder: '例如: /home/user/projects',
            value: defaultPath,
            ignoreFocusOut: true
        });

        const server: ServerConfig = {
            id: Date.now().toString(),
            name,
            host,
            port,
            username,
            authType: authType.value,
            password,
            privateKeyPath,
            remotePath: remotePath || undefined
        };

        await ConfigManager.addServer(context, server);
        vscode.window.showInformationMessage(`服务器配置 "${name}" 已保存`);

        return server;
    }

    static async showSelectServerDialog(context: vscode.ExtensionContext): Promise<ServerConfig | undefined> {
        const servers = await ConfigManager.getServers(context);

        if (servers.length === 0) {
            const addNew = await vscode.window.showInformationMessage(
                '没有配置的服务器',
                '添加服务器'
            );
            if (addNew) {
                return await this.showAddServerDialog(context);
            }
            return undefined;
        }

        const items = [
            ...servers.map(s => ({
                label: s.name,
                description: `${s.username}@${s.host}:${s.port}`,
                detail: s.remotePath || '/',
                server: s
            })),
            {
                label: '$(add) 添加新服务器',
                description: '',
                detail: '手动配置新的 SSH 服务器',
                server: null as ServerConfig | null
            },
            {
                label: '$(file-code) 从 SSH Config 导入',
                description: '',
                detail: '从 ~/.ssh/config 导入服务器配置',
                server: 'import' as const
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要连接的服务器',
            ignoreFocusOut: true
        });

        if (!selected) { return undefined; }

        if (selected.server === null) {
            return await this.showAddServerDialog(context);
        }

        if (selected.server === 'import') {
            return await this.showImportFromSSHConfig(context);
        }

        return selected.server;
    }

    static async showImportFromSSHConfig(context: vscode.ExtensionContext): Promise<ServerConfig | undefined> {
        try {
            const sshHosts = SSHConfigParser.parseConfig();

            if (sshHosts.length === 0) {
                vscode.window.showInformationMessage('未找到 SSH config 或没有可用的主机配置');
                return undefined;
            }

            const hostItems = sshHosts.map(h => ({
                label: h.name,
                description: h.hostname ? `${h.user || '?'}@${h.hostname}${h.port ? ':' + h.port : ''}` : '',
                detail: h.identityFile || '使用密码认证',
                host: h
            }));

            const selected = await vscode.window.showQuickPick(hostItems, {
                placeHolder: '选择要导入的 SSH 主机',
                ignoreFocusOut: true
            });

            if (!selected) { return undefined; }

            const h = selected.host;

            const password = await vscode.window.showInputBox({
                prompt: `${h.name} 的密码（使用私钥可留空）`,
                password: true,
                ignoreFocusOut: true
            });

            const username = h.user || 'root';
            const server: ServerConfig = {
                id: Date.now().toString(),
                name: h.name,
                host: h.hostname || h.name,
                port: h.port || 22,
                username: username,
                authType: h.identityFile ? 'privateKey' : 'password',
                password: password || undefined,
                privateKeyPath: h.identityFile,
                remotePath: username === 'root' ? '/root' : `/home/${username}`
            };

            await ConfigManager.addServer(context, server);
            vscode.window.showInformationMessage(`已导入: ${server.name}`);

            return server;
        } catch (error) {
            vscode.window.showErrorMessage(`导入失败: ${error}`);
            return undefined;
        }
    }

    static async showManageServersDialog(context: vscode.ExtensionContext): Promise<void> {
        const servers = await ConfigManager.getServers(context);

        if (servers.length === 0) {
            vscode.window.showInformationMessage('没有配置的服务器');
            return;
        }

        const items = servers.map(s => ({
            label: s.name,
            description: `${s.username}@${s.host}:${s.port}`,
            detail: s.remotePath || '/',
            server: s
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要管理的服务器'
        });

        if (!selected) { return; }

        const action = await vscode.window.showQuickPick(
            [
                { label: '$(edit) 编辑', value: 'edit' },
                { label: '$(trash) 删除', value: 'delete' }
            ],
            { placeHolder: `管理服务器: ${selected.server.name}` }
        );

        if (!action) { return; }

        if (action.value === 'delete') {
            const confirm = await vscode.window.showWarningMessage(
                `确定要删除服务器 "${selected.server.name}" 吗？`,
                { modal: true },
                '删除'
            );
            if (confirm) {
                await ConfigManager.removeServer(context, selected.server.id);
                vscode.window.showInformationMessage(`服务器 "${selected.server.name}" 已删除`);
            }
        } else if (action.value === 'edit') {
            vscode.window.showInformationMessage('编辑功能即将推出');
            // TODO: 实现编辑功能
        }
    }
}
