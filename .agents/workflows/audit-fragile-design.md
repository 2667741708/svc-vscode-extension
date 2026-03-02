---
description: 对 VS Code 扩展进行脆弱设计审查与修复的完整流程
---

# VS Code 扩展脆弱设计审查与修复

## 前提
- 项目为 TypeScript VS Code 扩展
- 具备 `npm run compile` 和 `npm run lint`

## 步骤

### 1. 收集审查目标
列出 `src/` 目录下所有 `.ts` 文件，优先审查以下角色文件：
- `extension.ts` (入口)
- `*Client.ts` / `*Provider.ts` (通信/IO 层)
- `*Manager.ts` / `*Pool.ts` (资源管理)
- `*Engine.ts` (业务逻辑)

### 2. 逐文件审查七大脆弱模式
参照 `.agents/skills/vscode-extension-audit/SKILL.md` 中的检查表。

### 3. 交叉验证功能规格
对照 `TEST_REPORT.md` 确认 `package.json` 中的命令和配置项是否齐全。

### 4. 撰写实施计划
输出 `implementation_plan.md`，请求用户审批。

### 5. 按组件逐一修复
// turbo-all
遵循最小修改原则，每个组件完成后立即运行：
```bash
npm run compile
```

### 6. 修复完成后完整验证
// turbo
```bash
npm run compile
```
// turbo
```bash
npm run lint
```

### 7. 若 lint 有问题先自动修复
// turbo
```bash
npm run lint -- --fix
```

### 8. 更新文档
- `error_resolution.md`
- `CHANGELOG_修改记录.md`
- walkthrough
