# tiny-dsh · 项目说明与设计要点

> 面向读者的项目笔记：事实、设计取舍、已知限制、验证入口。
> 所有数字与断言都可以在仓库里验证。

## 事实卡

| 项目 | 事实 |
|---|---|
| 内核 | `@deepseek-ai/cordis`（Context / Service / effect / inject）；手写内核 0 行 |
| 服务 seam | 13 个，见下表 |
| 代码量 | `src/` 39 个文件 ≈ 4050 行；`test/` 12 个文件 ≈ 2400 行 |
| 测试 | 104 passed（`pnpm test`） |
| 构建 | 无。Node 22 原生类型擦除，直接 `node src/index.ts` |
| 提交 | 一个里程碑一个 commit（D1–D7 + E1–E4，另有文档与 e2e 收尾） |
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

完整文件索引见 [ARCHITECTURE.md](./ARCHITECTURE.md) 第 11 节。

## 五个关键设计决策

1. **Session 存事件、消息靠投影。** 历史改写（清空、压缩）都表达成新事件，投影现场折叠。好处：不会出现「消息与事件不一致」，压缩可回放、可审计。
2. **tool_call 必须配对。** 取消多工具轮次时，先把当前及之后的所有 call 写成取消结果、落 `tool/result`，**再**抛 `AbortError`。否则投影出的 assistant 消息有 `tool_calls` 却没有 tool 回复，此后该 session 每次请求都会被服务端拒绝。
3. **压缩不是删历史，而是遮蔽。** 摘要消息带 `surfaceOp: { op: 'replace', start, end }`，投影时在**区间起点**插入它、隐藏旧区间。区间边界必须落在 tool_call/result 配对完整的位置上；摘要失败只留 `compaction/start`，不写 `end`。
4. **默认拒绝。** 没有审批通道时 `approval.request()` 返回 `deny`（fail closed），而不是放行。DSH 的 `never` 是「不询问、直接拒绝」；`danger-full-access` 之所以能「全放行」，是因为沙箱模式本身已放行、工具不再触发审批。
5. **框架与业务的边界。** `core/` 不 import cordis（纯逻辑、可单测），`plugins/` 才把它包成 Service。两个副作用容易踩：Service 方法里的 `this` 是 tracing 影子代理（不能用 `#` 私有字段、不能做函数身份比较）。

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
