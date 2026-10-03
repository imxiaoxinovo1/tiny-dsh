# tiny-dsh · 简历与项目说明

> 这份文档是「可以直接抄进简历的文案 + 面试时能对上的事实」。
> 所有数字与断言都可以在仓库里验证，验证入口见文末。

## 简历（可直接复制）

**tiny-dsh · 基于 cordis 从零实现的 Coding Agent Harness（个人项目）**
技术栈：TypeScript（Node 原生类型擦除，零构建）· cordis · DeepSeek Chat Completions（流式 + tool_calling）· node:test · Biome

- 基于 cordis 把 Harness 拆成 **13 个可替换 seam**（会话 / 工具 / 模型 / 提示词 / 审批 / 沙箱 / 持久化 / 压缩 / 权限 / 目标），统一 Definition–Provider–Consumer 三段式；核心链路零框架依赖、可独立单测。
- 实现**追加式事件日志 + 消息投影**：Session 只存事件，发给模型的消息由 `deriveMessages()` 现场投影；取消多工具轮次时先补齐 tool_call 配对再抛出，保证任意时刻投影都是合法请求。
- 实现**流式 tool-calling 全链路**：SSE 增量解析（末行无换行、`data:[DONE]`）→ tool_call 分片拼装（name 去重、arguments 等流结束再解析）→ 统一执行流水线（未知工具与内部异常收敛为 `isError`）→ 结果回写事件日志。
- 实现 **workspace 路径闸门与审批**：词法拒绝绝对路径与 `../`，`realpath` 拒绝越界软链；没有审批通道时写操作 fail closed；再由权限预设把 sandbox 模式与审批策略捆绑（含派生 `custom`）。
- 实现**追加式 JSONL 持久化与崩溃恢复**：首行 SessionHeader + 事件逐行落盘、写入串行化；损坏行（含崩溃残留半行）只丢该行而不使加载失败；CLI 支持 `/sessions` `/resume` `/delete`。
- 实现**基于 surface 遮蔽的上下文压缩**：token 计量 → 工具大结果剪枝并重新计量 → 旧区间摘要成检查点（`compaction/start → summary → user/message(surfaceOp) → end`）；事件只追加，历史改写靠投影遮蔽而非删除；摘要失败不落 `end`。
- 实现**持久完成目标**：四阶段状态机 + Round 配额，`/continue` 开新轮、到上限停止自动续行；目标经 `goal/change` 事件持久化后可恢复。

设计参照 DeepSeek Harness 的公开文档与 cordis 教程；内核为 cordis，未自研插件 / DI 框架。

## 事实卡（面试前对齐）

| 项目 | 事实 |
|---|---|
| 内核 | `@deepseek-ai/cordis`（Context / Service / effect / inject）；手写内核 0 行 |
| 服务 seam | 13 个，见下表 |
| 代码量 | `src/` 39 个文件 ≈ 4050 行；`test/` 12 个文件 ≈ 2400 行 |
| 测试 | 104 passed（`node --test test/*.test.ts`） |
| 构建 | 无。Node 22 原生类型擦除直接 `node src/index.ts` |
| 提交 | 11 个，D1–D7 + E1–E4，一个里程碑一个 commit |
| 质量门 | `pnpm typecheck` / `pnpm lint` 零告警 |

### seam 一览

| service | 职责 | 里程碑 |
|---|---|---|
| `ctx.sessions` | 追加式事件日志 + `deriveMessages()` 投影 | D2 |
| `ctx.tools` | 工具注册表 + OpenAI function schema + 统一执行结果 | D3 |
| `ctx.llm` | Provider 注册与路由 + 流式拼装 | D4 |
| `ctx.agentLoop` | model → tool → model 推进 | D5 |
| `ctx.agents` | Agent 注册表与取消入口 | D5 |
| `ctx.systemPrompt` | section / context 按 order 组装 | D6 |
| `ctx.approval` | 审批请求与结果（默认拒绝） | D7 |
| `ctx.sandbox` | workspace 路径闸门 + 命令策略 | D7 |
| `ctx.persistence` | JSONL 落盘与恢复 | E1 |
| `ctx.tokenMeter` | token 估算 | E2 |
| `ctx.compaction` | 阈值压缩（surface 遮蔽） | E2 |
| `ctx.permissionPresets` | sandbox 模式 × 审批策略的具名捆绑 | E3 |
| `ctx.goal` | 持久目标 + Round | E4 |

## 值得在面试里讲的五个决策

1. **Session 存事件、消息靠投影。** 历史改写（清空、压缩）都表达成新事件，投影现场折叠。好处：不会出现「消息与事件不一致」，压缩可回放、可审计。
2. **tool_call 必须配对。** 取消多工具轮次时，先把当前及之后的所有 call 写成取消结果、落 `tool/result`，**再**抛 `AbortError`。否则投影出的 assistant 消息有 `tool_calls` 却没有 tool 回复，此后该 session 每次请求都会被服务端拒绝。
3. **压缩不是删历史，而是遮蔽。** 摘要消息带 `surfaceOp: { op: 'replace', start, end }`，投影时在**区间起点**插入它、隐藏旧区间。区间边界必须落在 tool_call/result 配对完整的位置上。
4. **默认拒绝。** 没有审批通道时 `approval.request()` 返回 `deny`（fail closed），而不是放行。DSH 的 `never` 是「不询问、直接拒绝」；`danger-full-access` 之所以能「全放行」，是因为沙箱模式本身已放行、工具不再触发审批。
5. **框架 vs 业务的边界。** `core/` 不 import cordis（纯逻辑、可单测），`plugins/` 才把它包成 Service。两个副作用容易踩：Service 方法里的 `this` 是 tracing 影子代理（不能用 `#` 私有字段、不能做函数身份比较）。

## 诚实声明与已知限制

- 设计**参照** DeepSeek Harness 公开文档与 cordis 教程，不是原创概念；原创部分是这套 seam 的具体设计与取舍。
- `shell` 工具的默认 runner 用 `child_process.spawn` + 管道；在受限沙箱下无法执行，因此「超时 / 输出截断」的测试走的是**可注入 runner** 的策略层，真实 spawn 路径未在受限环境端到端验证。
- 真实模型调用需要 `DEEPSEEK_API_KEY`；未配置时启动不受影响，只有真正发请求才报错。

## 验证入口

```bash
pnpm install
pnpm test          # 104 个行为测试
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check .
pnpm start         # 组合根：打印就绪与服务清单

# 真实端到端（需要 .env 里的 DEEPSEEK_API_KEY）
pnpm run e2e                                    # 一次带工具往返的 run
pnpm run e2e "创建 note.txt 并读回来"            # 写路径：闸门 + 审批 + read/write
$env:TINY_DSH_MAX_TOKENS=10; $env:TINY_DSH_E2E_TURNS=6; pnpm run e2e "Reply OK"   # 强制真实压缩
$env:TINY_DSH_E2E_GOAL="Reply with the next integer only."; $env:TINY_DSH_MAX_GOAL_ROUNDS=2; pnpm run e2e   # 目标模式：Round 上限会停
```

设计文档见 [ARCHITECTURE.md](./ARCHITECTURE.md)；里程碑与验收标准见 [ROADMAP.md](./ROADMAP.md)。
