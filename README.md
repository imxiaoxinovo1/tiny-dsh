# tiny-dsh

[![CI](https://github.com/imxiaoxinovo1/tiny-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/imxiaoxinovo1/tiny-dsh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)
![Build](https://img.shields.io/badge/build-none%20(native%20type%20stripping)-blue.svg)

**tiny-dsh** is a minimal coding-agent harness built from scratch on [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis), organized by the capability-seam layout of DeepSeek Harness (DSH). It is not a DSH fork and contains no DSH source code.

- **13 swappable seams** (`ctx.sessions` / `tools` / `llm` / `systemPrompt` / `approval` / `sandbox` / `persistence` / `tokenMeter` / `compaction` / `permissionPresets` / `agentLoop` / `agents` / `goal`); `src/core` holds pure logic and never imports the framework.
- **Append-only event log + projection**: sessions store events, and the messages sent to the model are derived on the fly — history rewrites (compaction) are surface operations, not deletions.
- **Structured tool calling**: SSE streaming → incremental `tool_call` reassembly → one execution pipeline (unknown tools and thrown errors become `isError` results) → results written back to the log.
- **Safe by default**: workspace path gate (absolute paths, `../` and symlink escapes rejected), approval that fails closed without a channel, JSONL persistence with crash recovery, and surface-op based context compaction.
- **No build step**: runs on Node 22 native type stripping. `pnpm start` for the REPL, `pnpm test` for 100+ behavioural tests.

---

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

pnpm run e2e            # 真实模型端到端冒烟（需要 .env 里的 DEEPSEEK_API_KEY）
```

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) —— 分层、seam、核心数据结构、关键不变式、文件索引
- [ROADMAP.md](./ROADMAP.md) —— 里程碑与验收标准
- [PROJECT-NOTES.md](./PROJECT-NOTES.md) —— 事实卡、关键设计决策、已知限制、验证入口

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
E3：sandbox 模式 × 审批策略的权限预设（含派生 `custom`），见 [`src/core/permission-preset.ts`](./src/core/permission-preset.ts)。
E4：持久完成目标（四阶段）+ Round 上限 + `/continue` 续行，见 [`src/core/goal.ts`](./src/core/goal.ts)。实现进度见 [ROADMAP.md](./ROADMAP.md)。

D1–D7 与 E1–E4 全部完成，共 120 个测试。

## Jev 压缩实验与 CLI

CLI 默认显示简洁页头、思考状态与工具路径；`/help` 查看命令，`/new` 开新会话，`/status` 查看状态。`pnpm run preview:cli` 无需 API 即可预览界面。`NO_COLOR` 可关闭颜色；`TINY_DSH_DEBUG=1` 显示启动诊断。

Jev 仅提供重要性提示，DeepSeek 生成摘要，完整旧区间不因评分被删除。默认 `TINY_DSH_JEV_MODE=off`；`shadow` 仅观察，`assisted` 把重点原文交给摘要模型。启用前在本仓库 `.env` 设置 `TYPESAFE_API_KEY`。

```powershell
$env:TINY_DSH_JEV_MODE='assisted'
pnpm start
```

首轮真实试验没有显示超出输入修复的质量收益，因此保持默认关闭。方案、数据边界与结果见 [实验报告](docs/experiments/jev-compaction-pilot.md)。

启动欢迎页带 Tiny-dsh 字标与模型/目录/权限信息卡；窄终端自动隐藏大字标。回答区保持流式输出与原文缩进，工具操作使用简短标签。`/status` 显示紧凑状态卡。
