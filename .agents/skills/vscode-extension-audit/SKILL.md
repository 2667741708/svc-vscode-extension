---
description: 如何对 VS Code 扩展项目进行脆弱设计审查与修复
---

# VS Code 扩展脆弱设计审查与修复 (Skill)

本 Skill 定义了一套系统化的方法论，用于对 VS Code TypeScript 扩展项目进行脆弱设计审查（Fragile Design Audit）并实施修复。适用于任何基于 TypeScript 的 VS Code 扩展。

## 前置要求

- 项目使用 TypeScript + VS Code Extension API
- 项目具有 `npm run compile` 和 `npm run lint` 脚本
- 对项目的 `TEST_REPORT.md` 或等效的功能规格文档有可访问权限

## 工作流程

### 阶段一：审查 (PLANNING)

1. **列出全部源码文件**
   ```
   find_by_name Extensions=["ts"] SearchDirectory="src/"
   ```

2. **逐文件审查**，重点关注以下 7 类脆弱模式：

   | 脆弱模式 | 检查方法 | 常见位置 |
   |---------|---------|---------|
   | **定时器泄漏** | `setTimeout`/`setInterval` 是否有对应的 `clearTimeout`/`clearInterval` | RPC 客户端、心跳机制 |
   | **并发竞争** | async 方法中 `if (!x) { x = await create() }` 模式是否有 Promise 合并 | 连接池、缓存 |
   | **同步 IO** | `fs.xxxSync` 在 async 方法中使用 → 阻塞事件循环 | FileSystemProvider |
   | **早期 return 阻断** | `activate()` 中条件不满足直接 return → 后续注册被跳过 | extension.ts |
   | **未注册命令** | `executeCommand('xxx')` 调用但 `registerCommand('xxx')` 缺失 | TreeView → extension |
   | **资源复用 bug** | 对象被复用但其内部状态已死 (如关闭的连接、disposed 的 emitter) | Terminal PTY、连接池 |
   | **API 误用** | 第三方库返回值语义理解错误 (如 `exists()` 返回 `false\|string` 而非抛异常) | SFTP 客户端 |

3. **交叉验证**：将审查结果与 `TEST_REPORT.md` 对照，确认功能对齐情况

4. **输出实施计划** → `implementation_plan.md`，等待用户审批

### 阶段二：修复 (EXECUTION)

遵循**最小修改原则**，按组件逐一修复：

1. **定时器泄漏修复模式**
   ```typescript
   // 在 pendingRequests 中增加 timeoutId 字段
   private pendingRequests = new Map<number, {
       resolve: (result: any) => void;
       reject: (error: Error) => void;
       timeoutId: ReturnType<typeof setTimeout>;  // ← 新增
   }>();

   // 创建请求时保存 timeoutId
   const timeoutId = setTimeout(() => { /* timeout逻辑 */ }, 30000);
   this.pendingRequests.set(id, { resolve, reject, timeoutId });

   // 处理响应时清除
   clearTimeout(pending.timeoutId);
   ```

2. **并发竞争修复模式 (Promise 合并)**
   ```typescript
   private pendingConnections: Map<string, Promise<Connection>> = new Map();

   async getConnection(key: string): Promise<Connection> {
       const existing = this.connections.get(key);
       if (existing?.isConnected()) return existing;

       const pending = this.pendingConnections.get(key);
       if (pending) return pending;  // 请求合并

       const promise = (async () => {
           try {
               const conn = new Connection();
               await conn.connect();
               this.connections.set(key, conn);
               return conn;
           } finally {
               this.pendingConnections.delete(key);
           }
       })();
       this.pendingConnections.set(key, promise);
       return promise;
   }
   ```

3. **同步 IO → 异步 IO**
   ```typescript
   // 替换表
   fs.statSync(p)      → await fs.promises.stat(p)
   fs.readFileSync(p)   → await fs.promises.readFile(p)
   fs.readdirSync(p)    → await fs.promises.readdir(p)
   fs.writeFileSync(p)  → await fs.promises.writeFile(p)
   fs.mkdirSync(p)      → await fs.promises.mkdir(p)
   fs.rmSync(p)         → await fs.promises.rm(p)
   fs.unlinkSync(p)     → await fs.promises.unlink(p)
   fs.renameSync(a, b)  → await fs.promises.rename(a, b)
   fs.existsSync(p)     → try { await fs.promises.access(p); true } catch { false }
   ```

4. **异步队列模式（替代 isSyncing 单锁）**
   ```typescript
   private pendingOps: Map<string, { uri: Uri; op: string }> = new Map();

   async performSync(uri: Uri, op: string): Promise<void> {
       if (this.isSyncing) {
           this.pendingOps.set(uri.fsPath, { uri, op });  // 最新覆盖旧
           return;
       }
       this.isSyncing = true;
       try {
           // 执行同步...
       } finally {
           this.isSyncing = false;
           this.drainPendingOps();  // 自动排干
       }
   }

   private drainPendingOps(): void {
       if (this.pendingOps.size === 0) return;
       const [key, op] = this.pendingOps.entries().next().value;
       this.pendingOps.delete(key);
       this.performSync(op.uri, op.op);  // 链式执行
   }
   ```

5. **activate() 懒检查模式**
   ```typescript
   // 不要：
   if (!sidecar) { return; }  // ← 阻断后续注册

   // 应该：
   let available = false;
   if (sidecar) {
       try { await sidecar.start(); available = true; }
       catch { /* 仅警告 */ }
   }
   // 命令注册无条件执行
   registerCommand('xxx', async () => {
       if (!available) { showError('...'); return; }
       // ...
   });
   ```

### 阶段三：验证 (VERIFICATION)

// turbo-all

1. 编译检查
   ```bash
   npm run compile
   ```
   预期：exit code 0，无错误

2. Lint 检查
   ```bash
   npm run lint
   ```
   预期：exit code 0，无错误无警告

3. 如果 lint 有问题，先尝试自动修复：
   ```bash
   npm run lint -- --fix
   ```

4. 重新编译确认修复未引入回归：
   ```bash
   npm run compile
   ```

### 阶段四：文档

1. 更新项目的 `error_resolution.md` — 追加条目
2. 更新项目的 `CHANGELOG_修改记录.md` — 追加版本记录
3. 创建 walkthrough — 总结所有变更和验证结果

## 注意事项

- **Windows PowerShell 陷阱**：不要用 `Set-Content` 写入 UTF-8 中文文件，会损坏编码。使用 `write_to_file` 工具代替。
- **PowerShell 语法**：`&&` 在 PowerShell 中不是有效的命令连接符，需要分开执行命令。
- **CRLF 文件处理**：`replace_file_content` 工具在处理 CRLF (`\r\n`) 文件时可能匹配失败，可用 `write_to_file` 覆盖整个文件。
- **最小修改原则**：每次修改只改动必要的代码行，保持组件间解耦。
