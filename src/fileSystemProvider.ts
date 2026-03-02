import * as vscode from 'vscode';
import { SFTPConnection } from './sftpClient';

/**
 * 目录缓存条目
 */
interface DirCacheEntry {
    entries: [string, vscode.FileType][];
    timestamp: number;
}

/**
 * SVC 虚拟文件系统提供程序
 * 
 * 通过 svc:// URI scheme 将远程 SFTP 文件直接呈现在 VS Code 资源管理器中。
 * 无需本地挂载、无需 FUSE/WinFsp，纯 Node.js 层实现。
 * 
 * URI 格式: svc:///host/remote/path/to/file
 */
export class SVCFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private sftp: SFTPConnection | null = null;
    private remotePath: string = '/';

    /** 目录列表内存缓存（TTL 5秒, 减少高频 readDirectory 的 SFTP 往返） */
    private dirCache: Map<string, DirCacheEntry> = new Map();
    private readonly DIR_CACHE_TTL = 5000;

    constructor() { }

    /**
     * 设置 SFTP 连接和远程根路径
     */
    setSFTPConnection(sftp: SFTPConnection, remotePath: string): void {
        this.sftp = sftp;
        this.remotePath = remotePath;
        this.dirCache.clear();
    }

    /**
     * 断开连接并清理
     */
    clearConnection(): void {
        this.sftp = null;
        this.remotePath = '/';
        this.dirCache.clear();
    }

    /**
     * 检查是否已连接
     */
    isConnected(): boolean {
        return this.sftp !== null && this.sftp.isConnected();
    }

    /**
     * 将 svc:// URI 转换为远程绝对路径
     * 例: svc:///192.168.1.1/root/project/file.txt → /root/project/file.txt
     *      (authority = 192.168.1.1, path = /root/project/file.txt)
     */
    private toRemotePath(uri: vscode.Uri): string {
        // uri.path 以 / 开头，已是远程绝对路径
        return uri.path || '/';
    }

    private ensureConnected(): SFTPConnection {
        if (!this.sftp || !this.sftp.isConnected()) {
            throw vscode.FileSystemError.Unavailable('SFTP 未连接');
        }
        return this.sftp;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        // 远程文件系统不支持实时监听，返回空 disposable
        return new vscode.Disposable(() => { });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const sftp = this.ensureConnected();
        const remotePath = this.toRemotePath(uri);

        try {
            const stats = await sftp.stat(remotePath);
            return {
                type: stats.type === 'd' ? vscode.FileType.Directory : vscode.FileType.File,
                ctime: stats.modifyTime,
                mtime: stats.modifyTime,
                size: stats.size
            };
        } catch (error) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const sftp = this.ensureConnected();
        const remotePath = this.toRemotePath(uri);

        // 检查缓存
        const cached = this.dirCache.get(remotePath);
        if (cached && Date.now() - cached.timestamp < this.DIR_CACHE_TTL) {
            return cached.entries;
        }

        try {
            const files = await sftp.listDirectory(remotePath);
            const entries: [string, vscode.FileType][] = files.map(file => {
                const fileType = file.type === 'd'
                    ? vscode.FileType.Directory
                    : vscode.FileType.File;
                return [file.name, fileType] as [string, vscode.FileType];
            });

            // 写入缓存
            this.dirCache.set(remotePath, { entries, timestamp: Date.now() });
            return entries;
        } catch (error) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const sftp = this.ensureConnected();
        const remotePath = this.toRemotePath(uri);

        try {
            await sftp.mkdir(remotePath);
            // 清除父目录缓存
            this.invalidateParentCache(remotePath);
            this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
        } catch (error) {
            throw vscode.FileSystemError.Unavailable(`创建目录失败: ${error}`);
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const sftp = this.ensureConnected();
        const remotePath = this.toRemotePath(uri);

        try {
            const buffer = await sftp.readFile(remotePath);
            return new Uint8Array(buffer);
        } catch (error) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
        const sftp = this.ensureConnected();
        const remotePath = this.toRemotePath(uri);

        try {
            const exists = await sftp.exists(remotePath);

            if (exists && !options.overwrite) {
                throw vscode.FileSystemError.FileExists(uri);
            }

            if (!exists && !options.create) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            await sftp.writeFile(remotePath, Buffer.from(content));

            // 清除父目录缓存（新文件创建时）
            if (!exists) {
                this.invalidateParentCache(remotePath);
            }

            const changeType = exists
                ? vscode.FileChangeType.Changed
                : vscode.FileChangeType.Created;
            this._emitter.fire([{ type: changeType, uri }]);
        } catch (error) {
            if (error instanceof vscode.FileSystemError) {
                throw error;
            }
            throw vscode.FileSystemError.Unavailable(`写入文件失败: ${error}`);
        }
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        const sftp = this.ensureConnected();
        const remotePath = this.toRemotePath(uri);

        try {
            await sftp.delete(remotePath, options.recursive);
            // 清除父目录缓存
            this.invalidateParentCache(remotePath);
            this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
        } catch (error) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
        const sftp = this.ensureConnected();
        const oldRemotePath = this.toRemotePath(oldUri);
        const newRemotePath = this.toRemotePath(newUri);

        try {
            if (!options.overwrite) {
                const exists = await sftp.exists(newRemotePath);
                if (exists) {
                    throw vscode.FileSystemError.FileExists(newUri);
                }
            }

            await sftp.rename(oldRemotePath, newRemotePath);

            // 清除涉及的目录缓存
            this.invalidateParentCache(oldRemotePath);
            this.invalidateParentCache(newRemotePath);

            this._emitter.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri }
            ]);
        } catch (error) {
            if (error instanceof vscode.FileSystemError) {
                throw error;
            }
            throw vscode.FileSystemError.Unavailable(`重命名失败: ${error}`);
        }
    }

    /**
     * 清除指定路径的父目录缓存
     */
    private invalidateParentCache(remotePath: string): void {
        const parts = remotePath.split('/');
        parts.pop();
        const parentPath = parts.join('/') || '/';
        this.dirCache.delete(parentPath);
    }
}