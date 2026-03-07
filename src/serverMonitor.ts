import * as vscode from 'vscode';
import { Client } from 'ssh2';
import * as fs from 'fs';
import { ServerConfig } from './configManager';

/** 监控数据 */
export interface MonitorData {
    serverName: string;
    host: string;
    pythonProcesses: PythonProcess[];
    gpuInfo: GpuInfo[];
    cpuUsage: number;
    memUsage: { used: number; total: number };
    timestamp: number;
}

export interface PythonProcess {
    pid: string;
    cpu: string;
    mem: string;
    command: string;
    elapsed: string;
}

export interface GpuInfo {
    index: string;
    name: string;
    memUsed: string;
    memTotal: string;
    gpuUtil: string;
    temp: string;
}

type MonitorTreeItem = SectionItem | ProcessItem | GpuItem | StatItem | LoadingItem | NoConnectionItem;

/**
 * 服务器监控数据提供者
 * 通过 SSH 执行 nvidia-smi / ps aux 等命令获取服务器状态
 */
export class ServerMonitorProvider implements vscode.TreeDataProvider<MonitorTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MonitorTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private monitorData: MonitorData | null = null;
    private loading = false;
    private activeServer: ServerConfig | null = null;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor() { }

    /**
     * 绑定到一台服务器并开始自动刷新监控
     */

    setServer(server: ServerConfig): void {
        this.activeServer = server;
        this.monitorData = null;
        this.startAutoRefresh();
        this.refresh();
    }

    clearServer(): void {
        this.activeServer = null;
        this.monitorData = null;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this._onDidChangeTreeData.fire();
    }

    /** 30 秒自动刷新 */
    private startAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.refreshTimer = setInterval(() => {
            this.refresh();
        }, 30000);
    }

    refresh(): void {
        if (!this.activeServer) {
            this._onDidChangeTreeData.fire();
            return;
        }
        this.fetchMonitorData();
    }

    /**
     * 获取当前监控状态摘要（供弹窗显示）
     */
    getStatusSummary(): string {
        if (!this.activeServer) {
            return '未连接服务器';
        }
        if (!this.monitorData) {
            return this.loading ? '正在获取服务器状态数据，请稍候...' : '暂无服务器状态数据';
        }

        const data = this.monitorData;
        const timeStr = new Date(data.timestamp).toLocaleTimeString('zh-CN');

        let summary = `服务器: ${data.serverName} (${data.host})\n`;
        summary += `⏰ 更新时间: ${timeStr}\n\n`;
        summary += `⚙️ CPU 使用率: ${data.cpuUsage.toFixed(1)}%\n`;
        summary += `🧠 内存使用: ${data.memUsage.used} / ${data.memUsage.total} GB\n`;

        if (data.gpuInfo.length > 0) {
            summary += `\n🎮 GPU 状态:\n`;
            data.gpuInfo.forEach(gpu => {
                summary += `  - GPU ${gpu.index}: ${gpu.gpuUtil}% | ${gpu.memUsed}/${gpu.memTotal} MiB | ${gpu.temp}°C\n`;
            });
        } else {
            summary += `\n🎮 GPU 状态: 未检测到 GPU`;
        }

        if (data.pythonProcesses.length > 0) {
            summary += `\n🐍 Python 进程: ${data.pythonProcesses.length} 个正在运行`;
        }

        return summary;
    }

    getTreeItem(element: MonitorTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MonitorTreeItem): MonitorTreeItem[] {
        if (!this.activeServer) {
            return [new NoConnectionItem()];
        }

        if (this.loading || !this.monitorData) {
            return [new LoadingItem()];
        }

        if (!element) {
            // 根节点：三大分区
            const data = this.monitorData;
            const timeStr = new Date(data.timestamp).toLocaleTimeString('zh-CN');
            return [
                new SectionItem(
                    `🖥️ GPU 状态`,
                    data.gpuInfo.length > 0
                        ? `${data.gpuInfo.length} 张 GPU  •  更新: ${timeStr}`
                        : `无 GPU  •  更新: ${timeStr}`,
                    'gpu',
                    data.gpuInfo.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
                ),
                new SectionItem(
                    `⚙️ CPU & 内存`,
                    `CPU ${data.cpuUsage.toFixed(1)}%  内存 ${data.memUsage.used}/${data.memUsage.total} GB`,
                    'cpu',
                    vscode.TreeItemCollapsibleState.None
                ),
                new SectionItem(
                    `🐍 Python 进程`,
                    data.pythonProcesses.length > 0
                        ? `${data.pythonProcesses.length} 个进程运行中`
                        : '无 Python 进程',
                    'python',
                    data.pythonProcesses.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
                ),
            ];
        }

        if (element instanceof SectionItem) {
            const data = this.monitorData!;

            if (element.sectionType === 'gpu') {
                return data.gpuInfo.map(gpu => new GpuItem(gpu));
            }

            if (element.sectionType === 'python') {
                return data.pythonProcesses.map(p => new ProcessItem(p));
            }
        }

        return [];
    }

    /** 通过 SSH 采集监控数据 */
    private async fetchMonitorData(): Promise<void> {
        if (!this.activeServer) { return; }
        this.loading = true;
        this._onDidChangeTreeData.fire();

        const server = this.activeServer;

        const client = new Client();
        const config: Record<string, unknown> = {
            host: server.host,
            port: server.port,
            username: server.username,
            readyTimeout: 10000,
        };

        if (server.privateKeyPath) {
            try {
                config.privateKey = await fs.promises.readFile(server.privateKeyPath, 'utf8');
                if (server.password) {
                    config.passphrase = server.password;
                }
            } catch {
                // fallthrough
            }
        } else if (server.password) {
            config.password = server.password;
        }

        // 一次性执行所有监控命令
        const monitorScript = [
            // nvidia-smi（失败时输出 NO_GPU）
            `nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || echo "NO_GPU"`,
            `echo "---CPU---"`,
            // CPU 使用率（取1秒快照）
            `top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1 2>/dev/null || echo 0`,
            `echo "---MEM---"`,
            // 内存（GB）
            `free -g | awk '/^Mem/{print $3,$2}'`,
            `echo "---PYTHON---"`,
            // Python 进程（pid, %cpu, %mem, elapsed, command）
            `ps aux | grep -i python | grep -v grep | awk '{printf "%s\\t%s\\t%s\\t%s\\t", $1"%"$2, $3, $4, $10; for(i=11;i<=NF;i++) printf $i" "; print ""}' 2>/dev/null | head -20`,
            `echo "---END---"`,
        ].join(' && ');

        client.on('ready', () => {
            client.exec(monitorScript, (err, stream) => {
                if (err) {
                    this.loading = false;
                    client.end();
                    this._onDidChangeTreeData.fire();
                    return;
                }

                let output = '';
                stream.on('data', (data: Buffer) => { output += data.toString(); });
                stream.stderr.on('data', () => { /* 忽略 stderr */ });
                stream.on('close', () => {
                    client.end();
                    try {
                        this.monitorData = this.parseMonitorOutput(output, server);
                    } catch {
                        this.monitorData = null;
                    }
                    this.loading = false;
                    this._onDidChangeTreeData.fire();
                });
            });
        });

        client.on('error', () => {
            this.loading = false;
            this._onDidChangeTreeData.fire();
        });

        client.connect(config as Parameters<typeof client.connect>[0]);
    }

    private parseMonitorOutput(output: string, server: ServerConfig): MonitorData {
        const sections = output.split(/---(\w+)---/);
        const sectionMap: Record<string, string> = {};
        for (let i = 1; i < sections.length - 1; i += 2) {
            sectionMap[sections[i]] = sections[i + 1]?.trim() || '';
        }

        // GPU
        const gpuInfo: GpuInfo[] = [];
        const gpuRaw = sectionMap['CPU'] ? output.split('---CPU---')[0].trim() : output.trim();
        if (gpuRaw && !gpuRaw.includes('NO_GPU')) {
            for (const line of gpuRaw.split('\n')) {
                const parts = line.split(',').map(s => s.trim());
                if (parts.length >= 6) {
                    gpuInfo.push({
                        index: parts[0],
                        name: parts[1],
                        memUsed: parts[2],
                        memTotal: parts[3],
                        gpuUtil: parts[4],
                        temp: parts[5],
                    });
                }
            }
        }

        // CPU
        const cpuRaw = sectionMap['CPU'] || '0';
        const cpuUsage = parseFloat(cpuRaw.trim()) || 0;

        // 内存
        const memRaw = sectionMap['MEM'] || '0 0';
        const memParts = memRaw.trim().split(/\s+/);
        const memUsed = parseFloat(memParts[0]) || 0;
        const memTotal = parseFloat(memParts[1]) || 0;

        // Python 进程
        const pythonProcesses: PythonProcess[] = [];
        const pythonRaw = sectionMap['PYTHON'] || '';
        for (const line of pythonRaw.split('\n')) {
            if (!line.trim()) { continue; }
            const parts = line.split('\t');
            if (parts.length >= 4) {
                const userPid = parts[0].split('%');
                pythonProcesses.push({
                    pid: userPid[1] || '',
                    cpu: parts[1] || '0',
                    mem: parts[2] || '0',
                    elapsed: parts[3] || '',
                    command: parts[4]?.trim() || ''
                });
            }
        }

        return {
            serverName: server.name,
            host: server.host,
            gpuInfo,
            cpuUsage,
            memUsage: { used: memUsed, total: memTotal },
            pythonProcesses,
            timestamp: Date.now()
        };
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
    }
}

// ─── TreeItem 实现 ───────────────────────────────────────────────────────────

class SectionItem extends vscode.TreeItem {
    constructor(
        label: string,
        description: string,
        public readonly sectionType: 'gpu' | 'cpu' | 'python',
        collapsible: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsible);
        this.description = description;

        const iconMap = {
            'gpu': 'circuit-board',
            'cpu': 'pulse',
            'python': 'symbol-function'
        };
        this.iconPath = new vscode.ThemeIcon(iconMap[sectionType]);
    }
}

class GpuItem extends vscode.TreeItem {
    constructor(gpu: GpuInfo) {
        const memPercent = gpu.memTotal !== '0'
            ? ((parseInt(gpu.memUsed) / parseInt(gpu.memTotal)) * 100).toFixed(0)
            : '?';
        super(`GPU ${gpu.index}: ${gpu.name}`, vscode.TreeItemCollapsibleState.None);
        this.description = `${gpu.gpuUtil}% | ${gpu.memUsed}/${gpu.memTotal} MiB (${memPercent}%) | ${gpu.temp}°C`;
        this.iconPath = new vscode.ThemeIcon(parseInt(gpu.gpuUtil) > 80 ? 'flame' : 'circuit-board');
        this.tooltip = `GPU ${gpu.index}: ${gpu.name}\n占用率: ${gpu.gpuUtil}%\n显存: ${gpu.memUsed}/${gpu.memTotal} MiB\n温度: ${gpu.temp}°C`;
    }
}

class ProcessItem extends vscode.TreeItem {
    constructor(proc: PythonProcess) {
        // 截取命令的最后部分作为显示名
        const cmdParts = proc.command.split(' ');
        const scriptName = cmdParts.find(p => p.endsWith('.py')) || cmdParts[1] || proc.command;
        super(`PID ${proc.pid}: ${scriptName}`, vscode.TreeItemCollapsibleState.None);
        this.description = `CPU ${proc.cpu}%  内存 ${proc.mem}%`;
        this.tooltip = `PID: ${proc.pid}\nCPU: ${proc.cpu}%\n内存: ${proc.mem}%\n运行时间: ${proc.elapsed}\n命令: ${proc.command}`;
        this.iconPath = new vscode.ThemeIcon('play-circle');
    }
}

class StatItem extends vscode.TreeItem {
    constructor(label: string, icon: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

class LoadingItem extends vscode.TreeItem {
    constructor() {
        super('正在获取服务器状态...', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('loading~spin');
    }
}

class NoConnectionItem extends vscode.TreeItem {
    constructor() {
        super('未连接服务器', vscode.TreeItemCollapsibleState.None);
        this.description = '请先连接一台服务器';
        this.iconPath = new vscode.ThemeIcon('plug');
    }
}
