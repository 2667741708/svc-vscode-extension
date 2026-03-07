import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SSHConfigHost {
    name: string;
    hostname?: string;
    user?: string;
    port?: number;
    identityFile?: string;
}

export class SSHConfigParser {
    static async parseConfig(filePath?: string): Promise<SSHConfigHost[]> {
        const configPath = filePath || path.join(os.homedir(), '.ssh', 'config');
        const hosts: SSHConfigHost[] = [];

        try {
            await fs.promises.access(configPath);
        } catch {
            return hosts;
        }

        const content = await fs.promises.readFile(configPath, 'utf-8');
        let currentHost: SSHConfigHost | null = null;

        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();

            // 跳过注释和空行
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            // Host 定义
            const hostMatch = trimmed.match(/^Host\s+(.+)$/i);
            if (hostMatch) {
                if (currentHost) {
                    hosts.push(currentHost);
                }
                const hostName = hostMatch[1].trim();
                // 跳过通配符
                if (hostName.includes('*') || hostName.includes('?')) {
                    currentHost = null;
                    continue;
                }
                currentHost = { name: hostName };
                continue;
            }

            if (!currentHost) {
                continue;
            }

            // HostName (兼容行首不论缩进与否，只要包含HostName字段即可)
            const hostnameMatch = trimmed.match(/HostName\s+(.+)$/i);
            if (hostnameMatch) {
                currentHost.hostname = hostnameMatch[1].trim();
                continue;
            }

            // User
            const userMatch = trimmed.match(/User\s+(.+)$/i);
            if (userMatch) {
                currentHost.user = userMatch[1].trim();
                continue;
            }

            // Port
            const portMatch = trimmed.match(/Port\s+(\d+)$/i);
            if (portMatch) {
                currentHost.port = parseInt(portMatch[1]);
                continue;
            }

            // IdentityFile
            const identityMatch = trimmed.match(/IdentityFile\s+(.+)$/i);
            if (identityMatch) {
                let idFile = identityMatch[1].trim();
                // 展开 ~
                if (idFile.startsWith('~')) {
                    idFile = path.join(os.homedir(), idFile.substring(1));
                }
                currentHost.identityFile = idFile;
                continue;
            }
        }

        if (currentHost) {
            hosts.push(currentHost);
        }

        return hosts;
    }
}
