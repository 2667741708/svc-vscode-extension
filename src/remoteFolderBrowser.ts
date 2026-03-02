import * as vscode from 'vscode';
import { SFTPConnection } from './sftpClient';

export interface RemoteFile {
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    modifiedTime?: number;
}

export class RemoteFolderBrowser {
    private currentPath: string = '/';
    private pathHistory: string[] = [];
    private historyIndex: number = -1;

    constructor(
        private sftp: SFTPConnection,
        private remotePath: string = '/'
    ) {
        this.currentPath = remotePath;
        this.pathHistory.push(remotePath);
        this.historyIndex = 0;
    }

    async browse(): Promise<string | undefined> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const items = await this.getQuickPickItems();

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `当前路径: ${this.currentPath}`,
                ignoreFocusOut: true
            });

            if (!selected) {
                return undefined; // 用户取消
            }

            // 处理特殊操作
            if (selected.action === 'select') {
                return this.currentPath;
            } else if (selected.action === 'back') {
                await this.goBack();
            } else if (selected.action === 'forward') {
                await this.goForward();
            } else if (selected.action === 'parent') {
                await this.goToParent();
            } else if (selected.action === 'home') {
                await this.goToHome();
            } else if (selected.action === 'enter') {
                if (selected.file) {
                    await this.enterDirectory(selected.file.path);
                }
            }
        }
    }

    private async getQuickPickItems(): Promise<QuickPickItem[]> {
        const items: QuickPickItem[] = [];

        // 操作按钮
        items.push({
            label: '$(check) 选择此文件夹',
            description: this.currentPath,
            action: 'select'
        });

        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

        // 导航按钮
        if (this.historyIndex > 0) {
            items.push({
                label: '$(arrow-left) 后退',
                description: this.pathHistory[this.historyIndex - 1],
                action: 'back'
            });
        }

        if (this.historyIndex < this.pathHistory.length - 1) {
            items.push({
                label: '$(arrow-right) 前进',
                description: this.pathHistory[this.historyIndex + 1],
                action: 'forward'
            });
        }

        if (this.currentPath !== '/') {
            const parentPath = this.getParentPath(this.currentPath);
            items.push({
                label: '$(arrow-up) 上级目录',
                description: parentPath,
                action: 'parent'
            });
        }

        items.push({
            label: '$(home) 主目录',
            description: '/',
            action: 'home'
        });

        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

        // 文件和文件夹列表
        try {
            const files = await this.listDirectory(this.currentPath);

            // 先显示文件夹
            const directories = files.filter(f => f.isDirectory);
            const regularFiles = files.filter(f => !f.isDirectory);

            for (const dir of directories) {
                items.push({
                    label: `$(folder) ${dir.name}`,
                    description: '',
                    detail: dir.path,
                    action: 'enter',
                    file: dir
                });
            }

            if (regularFiles.length > 0) {
                items.push({ label: '文件', kind: vscode.QuickPickItemKind.Separator });
                for (const file of regularFiles) {
                    const sizeStr = file.size ? this.formatSize(file.size) : '';
                    items.push({
                        label: `$(file) ${file.name}`,
                        description: sizeStr,
                        detail: file.path,
                        action: 'none',
                        file: file
                    });
                }
            }
        } catch (error) {
            items.push({
                label: '$(error) 无法读取目录',
                description: error instanceof Error ? error.message : String(error),
                action: 'none'
            });
        }

        return items;
    }

    private async listDirectory(currentPath: string): Promise<RemoteFile[]> {
        try {
            const files = await this.sftp.listDirectory(currentPath);
            return files.map(file => ({
                name: file.name,
                path: file.path,
                isDirectory: file.type === 'd',
                size: file.size,
                modifiedTime: file.modifyTime
            }));
        } catch (error) {
            throw new Error(`无法读取目录: ${error}`);
        }
    }

    private async enterDirectory(path: string): Promise<void> {
        this.currentPath = path;

        // 添加到历史记录
        // 如果当前不在历史末尾，删除前面的记录
        if (this.historyIndex < this.pathHistory.length - 1) {
            this.pathHistory = this.pathHistory.slice(0, this.historyIndex + 1);
        }

        this.pathHistory.push(path);
        this.historyIndex++;
    }

    private async goBack(): Promise<void> {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.currentPath = this.pathHistory[this.historyIndex];
        }
    }

    private async goForward(): Promise<void> {
        if (this.historyIndex < this.pathHistory.length - 1) {
            this.historyIndex++;
            this.currentPath = this.pathHistory[this.historyIndex];
        }
    }

    private async goToParent(): Promise<void> {
        const parent = this.getParentPath(this.currentPath);
        await this.enterDirectory(parent);
    }

    private async goToHome(): Promise<void> {
        await this.enterDirectory('/');
    }

    private getParentPath(path: string): string {
        if (path === '/') {
            return '/';
        }
        const parts = path.split('/').filter(p => p);
        parts.pop();
        return '/' + parts.join('/');
    }

    private formatSize(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }
}

interface QuickPickItem extends vscode.QuickPickItem {
    action?: 'select' | 'back' | 'forward' | 'parent' | 'home' | 'enter' | 'none';
    file?: RemoteFile;
}
