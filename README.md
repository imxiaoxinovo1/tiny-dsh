# tiny-dsh

一个从零实现的、基于 [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) 的最小 Coding Agent Harness。

设计参照 DeepSeek Harness（DSH）的能力 seam 划分方式。**它不是 DSH 的分支，也不包含 DSH 或任何其它项目的源码。**

## 它是什么

```
Agent = Model + Harness
```

Harness 只负责三件事：

1. 把会话历史组织成模型能消费的请求
2. 把模型返回的结构化 tool_call 安全执行掉
3. 在两者之间循环，直到模型不再请求工具

## 技术栈

- **TypeScript**，由 Node 原生类型擦除直接运行，**无构建步骤**（没有 tsc 产物、没有 tsx）
- **Node.js >= 22.18**
- **cordis** —— 插件 / 服务内核，与 DSH 的选择一致
- **DeepSeek Chat Completions API** —— 流式 + 原生 tool_calling

## 运行

```bash
pnpm install
cp .env.example .env    # 填 DEEPSEEK_API_KEY
pnpm start

pnpm test               # node --test test/*.test.ts
pnpm typecheck          # tsc --noEmit
pnpm lint               # biome check .
```

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) —— 分层、seam、核心数据结构、关键不变式
- [ROADMAP.md](./ROADMAP.md) —— 里程碑与验收标准

## 状态

D1：cordis 骨架（Context / Plugin / Service / `ctx.effect()` / disposer），见 [`src/plugins/hello.ts`](./src/plugins/hello.ts)。
D2：Session 事件日志 + `deriveMessages()` 投影，见 [`src/core/session.ts`](./src/core/session.ts)。
D3：工具注册表 + OpenAI function schema + 统一执行结果，见 [`src/core/tool.ts`](./src/core/tool.ts)。
D4：LLM Provider 路由 + SSE 解析 + tool_calls 增量拼装，见 [`src/core/llm.ts`](./src/core/llm.ts)。
D5：Agent 与 Agent Loop（model → tool → model），见 [`src/core/loop.ts`](./src/core/loop.ts)。
D6：System Prompt 的 section / context 组装，见 [`src/core/prompt.ts`](./src/core/prompt.ts)。
D7：真实文件 / shell 工具、workspace 路径闸门、审批与 CLI，见 [`src/core/path.ts`](./src/core/path.ts)、[`src/plugins/approval.ts`](./src/plugins/approval.ts)。
E1：JSONL 会话持久化与崩溃恢复，CLI 支持 `/sessions` `/resume` `/delete`，见 [`src/core/persistence.ts`](./src/core/persistence.ts)。
E2：token 计量 + 工具结果剪枝 + 基于 surfaceOp 的区间摘要压缩，见 [`src/core/compaction.ts`](./src/core/compaction.ts)。
E3：sandbox 模式 × 审批策略的权限预设（含派生 `custom`），见 [`src/core/permission-preset.ts`](./src/core/permission-preset.ts)。实现进度见 [ROADMAP.md](./ROADMAP.md)。
