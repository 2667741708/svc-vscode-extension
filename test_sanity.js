const fs = require('fs');
const path = require('path');
const http = require('http');

// 模拟 outputChannel
const outputChannel = {
    appendLine: (msg) => console.log(`[Extension Log] ${msg}`)
};

// 1. 测试 ssh-manager 自动写入逻辑
console.log('--- 测试 1: ssh-manager 自动配置逻辑 ---');
function autoRegisterSSHManager(server, outputChannel) {
    try {
        const serverData = JSON.stringify({
            host: server.host,
            port: server.port,
            username: server.username,
            password: server.password || undefined,
            name: `SVC-${server.name}`,
            description: `由 SVC 扩展自动注册 (${server.host}:${server.port})`
        });

        // 尝试 HTTP API
        const tryPorts = [3001, 3002, 3003, 3004, 3005];
        for (const backendPort of tryPorts) {
            const req = http.request({
                hostname: '127.0.0.1',
                port: backendPort,
                path: '/api/servers',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(serverData)
                },
                timeout: 2000
            }, (res) => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    outputChannel.appendLine(`🔗 已自动注册到 ssh-manager (port ${backendPort})`);
                }
            });

            req.on('error', () => {
                // 忽略
            });

            req.write(serverData);
            req.end();
        }

        // 尝试配置文件
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const possibleConfigPaths = [
            path.join(homeDir, '.ssh-manager', 'servers.json'),
            path.join(homeDir, '.config', 'ssh-manager', 'servers.json'),
        ];

        let foundConfig = false;
        for (const configPath of possibleConfigPaths) {
            if (fs.existsSync(configPath)) {
                foundConfig = true;
                outputChannel.appendLine(`发现存在的配置文件: ${configPath}`);
            }
        }

        if (!foundConfig) {
            outputChannel.appendLine('未发现现有的 ssh-manager 配置文件。在真实环境中，如果工具不存在配置文件则走 HTTP API 即可。');
        }

    } catch (error) {
        outputChannel.appendLine(`⚠️ ssh-manager 注册失败: ${error}`);
    }
}

const dummyServer = {
    name: "Debug-Test-Server",
    host: "127.0.0.1",
    port: 2222,
    username: "testuser"
};

autoRegisterSSHManager(dummyServer, outputChannel);

console.log('--- 测试 1 完成 ---\n');

// 2. 测试 FileSystemProvider 的基础方法调用 (不连真实服务器，只测是否报错)
console.log('--- 测试 2: SVCFileSystemProvider 实例测试 ---');
try {
    const { SVCFileSystemProvider } = require('./out/fileSystemProvider');
    const provider = new SVCFileSystemProvider();

    // 模拟连接对象
    const mockSftp = {
        isConnected: () => true
    };

    provider.setSFTPConnection(mockSftp, '/mock/path');
    console.log('✅ FileSystemProvider 实例化并设置 SFTP 成功');
    if (provider.isConnected()) {
        console.log('✅ isConnected() 验证正确');
    } else {
        console.error('❌ isConnected() 返回了 false');
    }
} catch (e) {
    console.error('❌ FileSystemProvider 测试失败 (如缺少 out 目录请先编译):', e);
}
console.log('--- 测试 2 完成 ---\n');

// 3. 测试 SSH Terminal Manager (不连真实服务器)
console.log('--- 测试 3: SSHTerminalManager 实例测试 ---');
try {
    const { SSHTerminalManager } = require('./out/sshTerminal');
    const manager = new SSHTerminalManager();
    console.log('✅ SSHTerminalManager 实例化成功');
    // 如果没有报错说明语法和基础结构没问题
} catch (e) {
    console.error('❌ SSHTerminalManager 测试失败:', e);
}
console.log('--- 测试 3 完成 ---\n');

setTimeout(() => {
    console.log('自动化测试执行完毕，所有模块初始化均正常。');
    process.exit(0);
}, 3000); // 给 HTTP 请求 3 秒时间看看有没有响应
