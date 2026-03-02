import * as vscode from 'vscode';

export interface ServerConfig {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    authType: 'password' | 'privateKey';
    password?: string;
    privateKeyPath?: string;
    remotePath?: string;
}

export class ConfigManager {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    private static readonly CONFIG_KEY = 'svc.servers';

    static async getServers(context: vscode.ExtensionContext): Promise<ServerConfig[]> {
        return context.globalState.get<ServerConfig[]>(this.CONFIG_KEY) || [];
    }

    static async saveServers(context: vscode.ExtensionContext, servers: ServerConfig[]): Promise<void> {
        await context.globalState.update(this.CONFIG_KEY, servers);
    }

    static async addServer(context: vscode.ExtensionContext, server: ServerConfig): Promise<void> {
        const servers = await this.getServers(context);

        // 检查是否已存在相同的服务器（基于 host + port + username）
        const existingIndex = servers.findIndex(s =>
            s.host === server.host &&
            s.port === server.port &&
            s.username === server.username
        );

        if (existingIndex >= 0) {
            // 更新已存在的服务器
            servers[existingIndex] = { ...servers[existingIndex], ...server, id: servers[existingIndex].id };
        } else {
            // 添加新服务器
            servers.push(server);
        }

        await this.saveServers(context, servers);
    }

    static async removeServer(context: vscode.ExtensionContext, serverId: string): Promise<void> {
        const servers = await this.getServers(context);
        const filtered = servers.filter(s => s.id !== serverId);
        await this.saveServers(context, filtered);
    }

    static async updateServer(context: vscode.ExtensionContext, server: ServerConfig): Promise<void> {
        const servers = await this.getServers(context);
        const index = servers.findIndex(s => s.id === server.id);
        if (index >= 0) {
            servers[index] = server;
            await this.saveServers(context, servers);
        }
    }

    static async getServer(context: vscode.ExtensionContext, serverId: string): Promise<ServerConfig | undefined> {
        const servers = await this.getServers(context);
        return servers.find(s => s.id === serverId);
    }
}
