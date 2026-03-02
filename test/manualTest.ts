import { SidecarClient } from '../src/sidecarClient';
import * as path from 'path';

async function testSidecarCommunication() {
    console.log('=== Testing Sidecar Communication ===\n');

    // 获取 sidecar 路径
    const sidecarPath = path.join(__dirname, '../../sidecar/bin/sidecar.exe');
    console.log(`Sidecar path: ${sidecarPath}\n`);

    const client = new SidecarClient(sidecarPath);

    try {
        // 监听事件
        client.on('error', (error: Error) => {
            console.error('❌ Sidecar error:', error.message);
        });

        client.on('exit', (code: number | null, signal: string | null) => {
            console.log(`\nSidecar exited: code=${code}, signal=${signal}`);
        });

        // 启动 sidecar
        console.log('1. Starting sidecar...');
        await client.start();
        console.log('✅ Sidecar started successfully\n');

        // 等待一下让进程完全启动
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 测试状态查询
        console.log('2. Checking status...');
        const status = await client.status();
        console.log('✅ Status:', JSON.stringify(status, null, 2));
        console.log('   Expected: mounted = false\n');

        // 测试挂载
        console.log('3. Testing mount (will fail on Windows without WinFsp)...');
        try {
            const mountPath = 'Z:';
            const mountResult = await client.mount(mountPath);
            console.log('✅ Mount result:', JSON.stringify(mountResult, null, 2));
        } catch (error) {
            console.log('⚠️  Mount failed (expected on Windows without WinFsp):',
                error instanceof Error ? error.message : String(error));
        }
        console.log('');

        // 再次检查状态
        console.log('4. Checking status after mount attempt...');
        const status2 = await client.status();
        console.log('✅ Status:', JSON.stringify(status2, null, 2));
        console.log('');

        // 停止 sidecar
        console.log('5. Stopping sidecar...');
        await client.stop();
        console.log('✅ Sidecar stopped successfully\n');

        console.log('=== All tests completed! ===');
        process.exit(0);

    } catch (error) {
        console.error('❌ Test failed:', error);
        if (client.isRunning()) {
            await client.stop();
        }
        process.exit(1);
    }
}

testSidecarCommunication();
