import * as vscode from 'vscode';
import { Client, ClientChannel } from 'ssh2';
import { ServerConfig } from './configManager';
import * as fs from 'fs';

/**
 * SSH 终端管理器
 * 提供远程 SSH 终端功能
 */
export class SSHTerminalManager {
    private terminals: Map<string, SSHTerminal> = new Map();

    /**
     * 创建 SSH 终端
     */
    async createTerminal(
        server: ServerConfig,
        remotePath: string,
        outputChannel: vscode.OutputChannel
    ): Promise<vscode.Terminal> {
        const terminalKey = `${server.username}@${server.host}:${server.port}`;

        // 检查现有 PTY 是否仍然存活，若已关闭则创建新实例
        let sshTerminal = this.terminals.get(terminalKey);
        if (!sshTerminal || !sshTerminal.isAlive) {
            // 旧实例已死，清理并创建新的
            if (sshTerminal) {
                sshTerminal.dispose();
            }
            sshTerminal = new SSHTerminal(server, remotePath, outputChannel);
            this.terminals.set(terminalKey, sshTerminal);
        }

        const terminal = vscode.window.createTerminal({
            name: `SSH: ${server.name}`,
            pty: sshTerminal
        });

        return terminal;
    }

    /**
     * 关闭所有终端
     */
    dispose(): void {
        for (const terminal of this.terminals.values()) {
            terminal.dispose();
        }
        this.terminals.clear();
    }
}

/**
 * SSH 伪终端实现
 */
class SSHTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;

    private closeEmitter = new vscode.EventEmitter<number>();
    onDidClose: vscode.Event<number> = this.closeEmitter.event;

    private sshClient: Client;
    private stream: ClientChannel | undefined;
    private dimensions: vscode.TerminalDimensions = { rows: 30, columns: 120 };

    /** PTY 是否仍然活跃（SSH 连接未关闭） */
    public isAlive = true;

    constructor(
        private server: ServerConfig,
        private remotePath: string,
        private outputChannel: vscode.OutputChannel
    ) {
        this.sshClient = new Client();
    }

    async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
        if (initialDimensions) {
            this.dimensions = initialDimensions;
        }

        try {
            await this.connect();
        } catch (error) {
            this.isAlive = false;
            this.writeEmitter.fire(`\r\n❌ SSH 连接失败: ${error}\r\n`);
            this.closeEmitter.fire(1);
        }
    }

    private async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const config: Record<string, unknown> = {
                host: this.server.host,
                port: this.server.port,
                username: this.server.username,
                readyTimeout: 20000,
            };

            // 配置认证
            if (this.server.privateKeyPath) {
                try {
                    config.privateKey = fs.readFileSync(this.server.privateKeyPath, 'utf8');
                    if (this.server.password) {
                        config.passphrase = this.server.password;
                    }
                } catch (error) {
                    reject(new Error(`无法读取私钥: ${error}`));
                    return;
                }
            } else if (this.server.password) {
                config.password = this.server.password;
            }

            this.sshClient.on('ready', () => {
                this.outputChannel.appendLine(`✅ SSH 终端已连接: ${this.server.name}`);

                this.sshClient.shell({
                    rows: this.dimensions.rows,
                    cols: this.dimensions.columns,
                    term: 'xterm-256color'
                }, (err: Error | undefined, stream: ClientChannel) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    this.stream = stream;

                    // 将远程输出写入终端
                    stream.on('data', (data: Buffer) => {
                        this.writeEmitter.fire(data.toString());
                    });

                    stream.on('close', () => {
                        this.isAlive = false;
                        this.closeEmitter.fire(0);
                    });

                    stream.stderr.on('data', (data: Buffer) => {
                        this.writeEmitter.fire(data.toString());
                    });

                    // 切换到工作目录
                    if (this.remotePath) {
                        stream.write(`cd ${this.remotePath}\n`);
                    }

                    resolve();
                });
            });

            this.sshClient.on('error', (err: Error) => {
                this.outputChannel.appendLine(`❌ SSH 错误: ${err.message}`);
                reject(err);
            });

            this.sshClient.connect(config);
        });
    }

    close(): void {
        this.isAlive = false;
        if (this.stream) {
            this.stream.end();
        }
        this.sshClient.end();
    }

    handleInput(data: string): void {
        if (this.stream) {
            this.stream.write(data);
        }
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.dimensions = dimensions;
        if (this.stream) {
            this.stream.setWindow(dimensions.rows, dimensions.columns, 0, 0);
        }
    }

    dispose(): void {
        this.close();
    }
}
