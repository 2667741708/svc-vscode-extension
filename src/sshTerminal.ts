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

    /** 是否正在初始化中（隐藏 tmux/cd 等设置命令的输出） */
    private isInitializing = true;

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

        // 显示加载提示（初始化期间后续输出会被抑制）
        this.writeEmitter.fire('\r\n  🔄 正在连接到远程服务器...\r\n');

        try {
            await this.connect();
        } catch (error) {
            this.isInitializing = false;
            this.isAlive = false;
            this.writeEmitter.fire(`\r\n❌ SSH 连接失败: ${error}\r\n`);
            this.closeEmitter.fire(1);
        }
    }

    private async connect(): Promise<void> {
        const config: Record<string, unknown> = {
            host: this.server.host,
            port: this.server.port,
            username: this.server.username,
            readyTimeout: 20000,
        };

        // 配置认证
        if (this.server.privateKeyPath) {
            try {
                config.privateKey = await fs.promises.readFile(this.server.privateKeyPath, 'utf8');
                if (this.server.password) {
                    config.passphrase = this.server.password;
                }
            } catch (error) {
                throw new Error(`无法读取私钥: ${error}`);
            }
        } else if (this.server.password) {
            config.password = this.server.password;
        } else {
            // 回退尝试加载默认私钥或 ssh-agent
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
                        config.privateKey = await fs.promises.readFile(keyPath, 'utf8');
                        foundKey = true;
                        break;
                    } catch (e) {
                        // ignore
                    }
                } catch {
                    // ignore file not found
                }
            }

            if (!foundKey && process.env.SSH_AUTH_SOCK) {
                config.agent = process.env.SSH_AUTH_SOCK;
            }
        }

        return new Promise((resolve, reject) => {
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

                    // 将远程输出写入终端（初始化期间抑制输出）
                    stream.on('data', (data: Buffer) => {
                        if (this.isInitializing) {
                            // 初始化阶段：抑制 SSH 登录横幅、tmux/cd 命令回显
                            return;
                        }
                        this.writeEmitter.fire(data.toString());
                    });

                    stream.on('close', () => {
                        this.isAlive = false;
                        this.isInitializing = false;
                        this.closeEmitter.fire(0);
                    });

                    stream.stderr.on('data', (data: Buffer) => {
                        if (this.isInitializing) { return; }
                        this.writeEmitter.fire(data.toString());
                    });

                    // 注入 Tmux 持久化终端支持
                    setTimeout(() => {
                        const sessionName = `svc_term_${this.server.username}_${this.server.host}`.replace(/[^a-zA-Z0-9_]/g, '_');
                        // 构建注入指令：检查是否存在该会话，不存在则创建并设置鼠标滚轮与历史长度，最后 attach
                        const tmuxCmd = `if command -v tmux >/dev/null 2>&1; then tmux has-session -t ${sessionName} 2>/dev/null || (tmux new-session -d -s ${sessionName} && tmux set-option -t ${sessionName} -g mouse on && tmux set-option -t ${sessionName} -g history-limit 100000); tmux attach-session -t ${sessionName}; else echo "tmux not found"; fi`;

                        stream.write(`${tmuxCmd}\n`);

                        // cd 到目标路径，然后结束初始化并清屏
                        const finishInit = () => {
                            this.isInitializing = false;
                            // 发送 ANSI 清屏序列，清除加载提示
                            this.writeEmitter.fire('\x1b[2J\x1b[H');
                            // 在远程 shell 中也清屏
                            stream.write('clear\n');
                        };

                        if (this.remotePath) {
                            // 等待 tmux 附着完成
                            setTimeout(() => {
                                stream.write(`cd "${this.remotePath}" 2>/dev/null\n`);
                                // 等 cd 完成后清屏并结束初始化
                                setTimeout(finishInit, 300);
                            }, 800);
                        } else {
                            setTimeout(finishInit, 800);
                        }
                    }, 500);

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
