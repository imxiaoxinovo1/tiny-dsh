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
D2：Session 事件日志 + `deriveMessages()` 投影，见 [`src/core/session.ts`](./src/core/session.ts)。实现进度见 [ROADMAP.md](./ROADMAP.md)。
