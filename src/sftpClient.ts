import SFTPClient from 'ssh2-sftp-client';
import { ServerConfig } from './configManager';
import * as fs from 'fs';

export interface RemoteFileInfo {
    name: string;
    path: string;
    type: 'd' | '-' | 'l';  // directory, file, symlink
    size: number;
    modifyTime: number;
}

export class SFTPConnection {
    private client: SFTPClient;
    private connected: boolean = false;
    private config: ServerConfig;

    constructor(config: ServerConfig) {
        this.client = new SFTPClient();
        this.config = config;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            return;
        }

        const connectConfig: Record<string, unknown> = {
            host: this.config.host,
            port: this.config.port,
            username: this.config.username,
        };

        // 优先使用私钥，其次使用密码
        if (this.config.privateKeyPath) {
            try {
                connectConfig.privateKey = fs.readFileSync(this.config.privateKeyPath, 'utf8');
                if (this.config.password) {
                    connectConfig.passphrase = this.config.password;
                }
            } catch (error) {
                throw new Error(`无法读取私钥文件: ${this.config.privateKeyPath}`);
            }
        } else if (this.config.password) {
            connectConfig.password = this.config.password;
        } else {
            throw new Error('必须提供密码或私钥');
        }

        // 连接超时设置
        connectConfig.readyTimeout = 20000;
        connectConfig.retries = 2;

        await this.client.connect(connectConfig);
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        if (this.connected) {
            await this.client.end();
            this.connected = false;
        }
    }

    async listDirectory(path: string): Promise<RemoteFileInfo[]> {
        this.ensureConnected();

        try {
            const list = await this.client.list(path);
            return list.map((item: { name: string; type: 'd' | '-' | 'l'; size: number; modifyTime: number }): RemoteFileInfo => ({
                name: item.name,
                path: this.joinPath(path, item.name),
                type: item.type,
                size: item.size,
                modifyTime: item.modifyTime
            }));
        } catch (error) {
            throw new Error(`无法列出目录 ${path}: ${error}`);
        }
    }

    async readFile(path: string): Promise<Buffer> {
        this.ensureConnected();

        try {
            const buffer = await this.client.get(path);
            return buffer as Buffer;
        } catch (error) {
            throw new Error(`无法读取文件 ${path}: ${error}`);
        }
    }

    async writeFile(path: string, content: Buffer): Promise<void> {
        this.ensureConnected();

        try {
            await this.client.put(content, path);
        } catch (error) {
            throw new Error(`无法写入文件 ${path}: ${error}`);
        }
    }

    async stat(path: string): Promise<RemoteFileInfo> {
        this.ensureConnected();

        try {
            const stats = await this.client.stat(path);
            return {
                name: this.getBasename(path),
                path: path,
                type: stats.isDirectory ? 'd' : '-',
                size: stats.size,
                modifyTime: stats.modifyTime
            };
        } catch (error) {
            throw new Error(`无法获取文件信息 ${path}: ${error}`);
        }
    }

    async exists(path: string): Promise<boolean> {
        this.ensureConnected();

        try {
            // ssh2-sftp-client.exists() 返回 false | 'd' | '-' | 'l'
            // 不会抛异常，需要检查返回值
            const result = await this.client.exists(path);
            return result !== false;
        } catch {
            return false;
        }
    }

    async mkdir(path: string): Promise<void> {
        this.ensureConnected();

        try {
            await this.client.mkdir(path, true);
        } catch (error) {
            throw new Error(`无法创建目录 ${path}: ${error}`);
        }
    }

    async delete(path: string, recursive: boolean = false): Promise<void> {
        this.ensureConnected();

        try {
            const stats = await this.stat(path);
            if (stats.type === 'd') {
                await this.client.rmdir(path, recursive);
            } else {
                await this.client.delete(path);
            }
        } catch (error) {
            throw new Error(`无法删除 ${path}: ${error}`);
        }
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        this.ensureConnected();

        try {
            await this.client.rename(oldPath, newPath);
        } catch (error) {
            throw new Error(`无法重命名 ${oldPath} -> ${newPath}: ${error}`);
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    private ensureConnected(): void {
        if (!this.connected) {
            throw new Error('SFTP 未连接');
        }
    }

    private joinPath(...parts: string[]): string {
        // Unix-style path join
        return parts
            .join('/')
            .replace(/\/+/g, '/')
            .replace(/\/$/, '') || '/';
    }

    private getBasename(path: string): string {
        const parts = path.split('/').filter(p => p);
        return parts[parts.length - 1] || '/';
    }
}

// 全局 SFTP 连接池
export class SFTPConnectionPool {
    private connections: Map<string, SFTPConnection> = new Map();
    // 并发保护：正在建立中的连接 Promise
    private pendingConnections: Map<string, Promise<SFTPConnection>> = new Map();

    async getConnection(config: ServerConfig): Promise<SFTPConnection> {
        const key = `${config.username}@${config.host}:${config.port}`;

        // 若已有可用连接，直接返回
        const existing = this.connections.get(key);
        if (existing && existing.isConnected()) {
            return existing;
        }

        // 若有正在建立的连接，等待它完成（请求合并）
        const pending = this.pendingConnections.get(key);
        if (pending) {
            return pending;
        }

        // 创建新连接，并存入 pending 防止并发重复创建
        const connectPromise = (async () => {
            const connection = new SFTPConnection(config);
            try {
                await connection.connect();
                this.connections.set(key, connection);
                return connection;
            } finally {
                this.pendingConnections.delete(key);
            }
        })();

        this.pendingConnections.set(key, connectPromise);
        return connectPromise;
    }

    async disconnect(config: ServerConfig): Promise<void> {
        const key = `${config.username}@${config.host}:${config.port}`;
        const connection = this.connections.get(key);

        if (connection) {
            await connection.disconnect();
            this.connections.delete(key);
        }
    }

    async disconnectAll(): Promise<void> {
        const promises = Array.from(this.connections.values()).map(conn =>
            conn.disconnect()
        );
        await Promise.all(promises);
        this.connections.clear();
    }
}
