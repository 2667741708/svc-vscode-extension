import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SFTPConnection } from './sftpClient';
import { IgnoreParser } from './ignoreParser';

export interface SyncStats {
    totalDirectories: number;
    totalFiles: number;
    ignoredFiles: number;
    scannedFiles: number;
}

/**
 * 本地缓存管理器
 * 负责管理远程文件的本地缓存，支持懒加载
 */
export class CacheManager {
    private cacheRoot: string;
    private metadataPath: string;
    private metadata: CacheMetadata = {};
    private ignoreParser: IgnoreParser;

    constructor(
        private serverKey: string,
        private remotePath: string,
        ignoreParser?: IgnoreParser
    ) {
        // 缓存根目录: ~/.svc-cache/<server-key>/<remote-path-hash>
        const remotePathHash = this.hashPath(remotePath);
        this.cacheRoot = path.join(
            os.homedir(),
            '.svc-cache',
            this.sanitizeKey(serverKey),
            remotePathHash
        );
        this.metadataPath = path.join(this.cacheRoot, '.svc-metadata.json');
        this.ignoreParser = ignoreParser || new IgnoreParser();
    }

    /**
     * 初始化缓存目录
     */
    async initialize(): Promise<void> {
        await fs.promises.mkdir(this.cacheRoot, { recursive: true });
        await this.loadMetadata();
    }

    /**
     * 获取本地缓存根目录
     */
    getCacheRoot(): string {
        return this.cacheRoot;
    }

    /**
     * 同步目录结构（只创建文件夹，不下载文件）
     * @param sftp SFTP 连接
     * @param remotePath 远程路径
     * @param progress 进度报告器
     * @param cancellationToken 取消令牌
     * @param maxDepth 最大递归深度（默认10）
     */
    async syncDirectoryStructure(
        sftp: SFTPConnection,
        remotePath: string,
        progress?: { report: (value: { message?: string; increment?: number }) => void },
        cancellationToken?: { isCancellationRequested: boolean },
        maxDepth: number = 10
    ): Promise<SyncStats> {
        const stats: SyncStats = {
            totalDirectories: 0,
            totalFiles: 0,
            ignoredFiles: 0,
            scannedFiles: 0
        };

        await this._syncDirectoryRecursive(
            sftp,
            remotePath,
            0,
            maxDepth,
            stats,
            progress,
            cancellationToken
        );

        await this.saveMetadata();
        return stats;
    }

    /**
     * 递归同步目录（内部方法）
     */
    private async _syncDirectoryRecursive(
        sftp: SFTPConnection,
        remotePath: string,
        depth: number,
        maxDepth: number,
        stats: SyncStats,
        progress?: { report: (value: { message?: string; increment?: number }) => void },
        cancellationToken?: { isCancellationRequested: boolean }
    ): Promise<void> {
        // 检查是否取消
        if (cancellationToken?.isCancellationRequested) {
            throw new Error('扫描已取消');
        }

        // 检查深度限制
        if (depth > maxDepth) {
            return;
        }

        const relPath = this.getRelativePath(remotePath);

        // 检查是否应该忽略
        if (this.ignoreParser.shouldIgnore(relPath, true)) {
            return;
        }

        const localPath = this.getLocalPath(remotePath);
        await fs.promises.mkdir(localPath, { recursive: true });
        stats.totalDirectories++;

        // 报告进度
        if (progress) {
            progress.report({
                message: `扫描中... 目录: ${stats.totalDirectories}, 文件: ${stats.totalFiles}`,
                increment: 1
            });
        }

        // 列出文件
        let files;
        try {
            files = await sftp.listDirectory(remotePath);
        } catch (error) {
            // 忽略无法访问的目录
            return;
        }

        // 递归同步子目录
        for (const file of files) {
            // 再次检查取消
            if (cancellationToken?.isCancellationRequested) {
                throw new Error('扫描已取消');
            }

            if (file.type === 'd') {
                await this._syncDirectoryRecursive(
                    sftp,
                    file.path,
                    depth + 1,
                    maxDepth,
                    stats,
                    progress,
                    cancellationToken
                );
            } else {
                // 创建文件元数据（标记为未下载）
                const fileRelPath = this.getRelativePath(file.path);
                const ignored = this.ignoreParser.shouldIgnore(fileRelPath, false);

                this.metadata[fileRelPath] = {
                    remotePath: file.path,
                    size: file.size,
                    mtime: file.modifyTime,
                    downloaded: false,
                    ignored: ignored
                };

                stats.totalFiles++;
                stats.scannedFiles++;

                if (ignored) {
                    stats.ignoredFiles++;
                }

                // 每100个文件报告一次进度
                if (stats.totalFiles % 100 === 0 && progress) {
                    progress.report({
                        message: `扫描中... 目录: ${stats.totalDirectories}, 文件: ${stats.totalFiles}`
                    });
                }
            }
        }
    }

    /**
     * 懒加载：下载单个文件（仅在打开时）
     */
    async downloadFile(sftp: SFTPConnection, remotePath: string): Promise<string> {
        const relPath = this.getRelativePath(remotePath);
        const localPath = this.getLocalPath(remotePath);

        // 检查文件是否已下载且未过期
        const meta = this.metadata[relPath];
        if (meta && meta.downloaded) {
            try {
                const stats = await fs.promises.stat(localPath);
                if (stats.isFile()) {
                    return localPath;
                }
            } catch {
                // 文件不存在，重新下载
            }
        }

        // 下载文件
        const dir = path.dirname(localPath);
        await fs.promises.mkdir(dir, { recursive: true });

        const buffer = await sftp.readFile(remotePath);
        await fs.promises.writeFile(localPath, buffer);

        // 更新元数据
        const fileInfo = await sftp.stat(remotePath);
        this.metadata[relPath] = {
            remotePath,
            size: fileInfo.size,
            mtime: fileInfo.modifyTime,
            downloaded: true,
            ignored: false
        };
        await this.saveMetadata();

        return localPath;
    }

    /**
     * 上传文件到远程
     */
    async uploadFile(sftp: SFTPConnection, localPath: string, remotePath: string): Promise<void> {
        const buffer = await fs.promises.readFile(localPath);
        await sftp.writeFile(remotePath, buffer);

        // 更新元数据
        const relPath = this.getRelativePath(remotePath);
        const stats = await fs.promises.stat(localPath);
        this.metadata[relPath] = {
            remotePath,
            size: stats.size,
            mtime: stats.mtimeMs,
            downloaded: true,
            ignored: false
        };
        await this.saveMetadata();
    }

    /**
     * 检查文件是否已下载
     */
    isFileDownloaded(remotePath: string): boolean {
        const relPath = this.getRelativePath(remotePath);
        const meta = this.metadata[relPath];
        return meta?.downloaded || false;
    }

    /**
     * 检查文件是否被忽略
     */
    isFileIgnored(remotePath: string, isDirectory: boolean): boolean {
        const relPath = this.getRelativePath(remotePath);
        return this.ignoreParser.shouldIgnore(relPath, isDirectory);
    }

    /**
     * 获取本地路径
     */
    getLocalPath(remotePath: string): string {
        const relPath = this.getRelativePath(remotePath);
        return path.join(this.cacheRoot, relPath);
    }

    /**
     * 获取相对路径
     */
    private getRelativePath(remotePath: string): string {
        const normalized = remotePath.replace(/\\/g, '/');
        const base = this.remotePath.replace(/\\/g, '/');

        if (normalized.startsWith(base)) {
            return normalized.substring(base.length).replace(/^\//, '');
        }
        return normalized.replace(/^\//, '');
    }

    /**
     * 加载元数据
     */
    private async loadMetadata(): Promise<void> {
        try {
            const content = await fs.promises.readFile(this.metadataPath, 'utf8');
            this.metadata = JSON.parse(content);
        } catch {
            this.metadata = {};
        }
    }

    /**
     * 保存元数据
     */
    private async saveMetadata(): Promise<void> {
        await fs.promises.writeFile(
            this.metadataPath,
            JSON.stringify(this.metadata, null, 2),
            'utf8'
        );
    }

    /**
     * 路径哈希
     */
    private hashPath(p: string): string {
        // 简单哈希，用于目录名
        let hash = 0;
        for (let i = 0; i < p.length; i++) {
            hash = ((hash << 5) - hash) + p.charCodeAt(i);
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * 清理服务器 key（移除不安全字符）
     */
    private sanitizeKey(key: string): string {
        return key.replace(/[^a-zA-Z0-9-_.]/g, '_');
    }

    /**
     * 清理缓存
     */
    async clear(): Promise<void> {
        try {
            await fs.promises.rm(this.cacheRoot, { recursive: true, force: true });
        } catch {
            // 忽略错误
        }
    }

    /**
     * 获取缓存统计信息
     */
    async getStats(): Promise<CacheStats> {
        const stats: CacheStats = {
            totalFiles: 0,
            downloadedFiles: 0,
            ignoredFiles: 0,
            totalSize: 0,
            downloadedSize: 0
        };

        for (const [, meta] of Object.entries(this.metadata)) {
            stats.totalFiles++;
            stats.totalSize += meta.size;

            if (meta.downloaded) {
                stats.downloadedFiles++;
                stats.downloadedSize += meta.size;
            }

            if (meta.ignored) {
                stats.ignoredFiles++;
            }
        }

        return stats;
    }
}

interface CacheMetadata {
    [relativePath: string]: FileMetadata;
}

interface FileMetadata {
    remotePath: string;
    size: number;
    mtime: number;
    downloaded: boolean;
    ignored: boolean;
}

interface CacheStats {
    totalFiles: number;
    downloadedFiles: number;
    ignoredFiles: number;
    totalSize: number;
    downloadedSize: number;
}
