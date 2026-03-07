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

        const startTime = Date.now();
        const connectConfig: Record<string, unknown> = {
            host: this.config.host,
            port: this.config.port,
            username: this.config.username,
        };

        // 优先使用私钥，其次使用密码
        if (this.config.privateKeyPath) {
            try {
                connectConfig.privateKey = await fs.promises.readFile(this.config.privateKeyPath, 'utf8');
                if (this.config.password) {
                    connectConfig.passphrase = this.config.password;
                }
            } catch (error) {
                throw new Error(`无法读取私钥文件: ${this.config.privateKeyPath}`);
            }
        } else if (this.config.password) {
            connectConfig.password = this.config.password;
        } else {
            // 尝试加载默认私钥或 ssh-agent
            const homeDir = process.env.HOME || process.env.USERPROFILE || '';
            const defaultKeys = [
                `${homeDir}/.ssh/id_rsa`,
                `${homeDir}/.ssh/id_ed25519`,
                `${homeDir}/.ssh/id_ecdsa`
            ];

            let foundKey = false;
            for (const keyPath of defaultKeys) {
                try {
                    await fs.promises.access(keyPath);
                    try {
                        connectConfig.privateKey = await fs.promises.readFile(keyPath, 'utf8');
                        foundKey = true;
                        break;
                    } catch (e) {
                        // 忽略读取错误，尝试下一个
                    }
                } catch {
                    // 文件不存在，尝试下一个
                }
            }

            if (!foundKey && process.env.SSH_AUTH_SOCK) {
                connectConfig.agent = process.env.SSH_AUTH_SOCK;
                foundKey = true;
            }

            if (!foundKey) {
                // 不再绝对阻断，让底层的 tryKeyboard 等可能去工作（如果实现），或最晚报错
                // throw new Error('必须提供密码或私钥');
            }
        }

        // 连接超时设置（优化：减少超时时间，添加 keepalive）
        connectConfig.readyTimeout = 10000;
        connectConfig.retries = 1;
        connectConfig.keepaliveInterval = 10000;
        connectConfig.keepaliveCountMax = 3;

        await this.client.connect(connectConfig);
        this.connected = true;

        const duration = Date.now() - startTime;
        console.log(`✅ SFTP 已连接: ${this.config.username}@${this.config.host}:${this.config.port} (${duration}ms)`);
    }

    async disconnect(): Promise<void> {
        if (this.connected) {
            await this.client.end();
            this.connected = false;
        }
    }

    async listDirectory(path: string): Promise<RemoteFileInfo[]> {
        this.ensureConnected();

        const startTime = Date.now();
        try {
            const list = await this.client.list(path);
            const duration = Date.now() - startTime;

            // 如果超过2秒，记录警告（可通过外部日志查看）
            if (duration > 2000) {
                console.warn(`⚠️ SFTP listDirectory 慢: ${path} 耗时 ${duration}ms (${list.length} 项)`);
            }

            return list.map((item: { name: string; type: 'd' | '-' | 'l'; size: number; modifyTime: number }): RemoteFileInfo => ({
                name: item.name,
                path: this.joinPath(path, item.name),
                type: item.type,
                size: item.size,
                modifyTime: item.modifyTime
            }));
        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`❌ SFTP listDirectory 失败: ${path} (${duration}ms)`, error);
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
