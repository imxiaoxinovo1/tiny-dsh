# tiny-dsh 路线图

每个里程碑都以「能跑通的验收测试」结束，写不出来就先别往下走。

## 约定

- 语言：TypeScript，由 Node 22.18+ 原生类型擦除直接运行，无构建步骤
- 测试：`node --test test/*.test.ts`，每个 core runtime 配一个测试文件；测试即行为文档
- 提交：一个里程碑至少一个 commit，message 用 `feat:` / `fix:` / `test:` / `docs:` 前缀
- 卡住时：先写测试，再写实现

## 核心阶段：吃透 DSH

### D1 骨架与 cordis 入门

目标：亲手跑通 Context、Plugin、Service、`ctx.effect()`、disposer。
产出：`src/index.ts`、`src/plugins/hello.ts`、`test/plugin.test.ts`
验收：
- `pnpm start` 打印就绪
- 插件卸载后它注册的 Service 消失
- 缺少 `inject` 声明时插件不加载，且报错可读
DSH 出处：docs/cordis-tutorial/01–07

### D2 Session 事件日志

目标：Session 存事件而不是存消息；`deriveMessages()` 负责投影。
产出：`src/core/session.ts`、`src/plugins/sessions.ts`、`test/session.test.ts`
验收：
- `user/message → assistant/tool_calls → tool/result → assistant/message` 能正确投影
- `reasoning_content` 随 `assistant/tool_calls` 一起保留
- 清空会话后 id 不变、投影为空
坑：投影时 tool_calls 的 arguments 要重新序列化成 JSON 字符串。

### D3 Tool Runtime 与执行流水线

目标：注册表 + OpenAI function schema + 统一执行结果。
产出：`src/core/tool.ts`、`src/plugins/tools.ts`、`test/tool.test.ts`
验收：
- `register()` 返回 disposer
- 未知工具返回 `isError: true`，而不是抛异常
- execute 内部抛错被收敛成 tool/result，不打断整个 run
DSH 出处：docs/subsystems/tools.md

### D4 LLM Adapter（DeepSeek 流式）

目标：Provider 注册表 + SSE 解析 + tool_calls 增量拼装。
产出：`src/core/llm.ts`、`src/providers/deepseek.ts`、`test/llm.test.ts`
验收：
- SSE 最后一行没有换行也能被冲出
- `data:[DONE]` 能识别
- 同一个 tool_call 分片到达时 name 不被重复拼接（否则会变成 `read_fileread_file`）
坑：`arguments` 是分片字符串，必须等流结束再 parse。

### D5 Agent 与 Agent Loop

目标：model → tool → model 的多轮推进。
产出：`src/core/agent.ts`、`src/core/loop.ts`、`src/plugins/agents.ts`、`src/plugins/agent-loop.ts`、`test/loop.test.ts`
验收：
- mock model 下完成一次完整工具往返
- 取消一次多工具轮次后，每个 tool_call 仍有对应 tool/result
- 连续 20 次工具调用后仍能正常结束（没有隐藏步数上限）
坑：取消时先把事件日志补一致，再抛异常。

### D6 System Prompt 与 Runtime Context

目标：命名 section / context 按 order 组装，支持动态文本。
产出：`src/core/prompt.ts`、`src/plugins/system-prompt.ts`、`src/plugins/runtime-context.ts`、`test/prompt.test.ts`
验收：
- 按 order 组装，空片段被跳过
- 工厂函数每次 assemble 都被重新调用（时间 / cwd 保持新鲜）
DSH 出处：docs/subsystems/system-prompt.md

### D7 真实工具、路径闸门与审批

目标：文件与 shell 工具、workspace 路径约束、`[Y/n]` 审批。
产出：`src/core/path.ts`、`src/tools/*.ts`、`src/plugins/sandbox.ts`、`src/plugins/approval.ts`、`src/cli/*.ts`
验收：
- `../` 与绝对路径被拒
- workspace 内部的软链指向外面时被拒
- 没有审批通道时写操作 fail closed
- 命令超时与输出截断生效
DSH 出处：docs/subsystems/filesystem.md、approval.md、sandbox.md

## 自有扩展：拉开差距的部分

### E1 JSONL 持久化与 /resume

目标：`ctx.persistence` seam + JSONL provider，事件落盘，进程重启后能恢复。
验收：
- 每 append 一个事件就落一行 JSONL
- 首行是 SessionHeader（id / 创建时间 / 格式版本）
- 崩溃留下的半行不会让加载失败
- CLI 支持 `/sessions`、`/resume <id>`、`/delete <id>`
DSH 出处：docs/subsystems/persistence.md

### E2 tokenMeter 与 compaction

目标：token 估算 + 达到阈值时把旧区间摘要成一个检查点。
验收：
- `compaction/start → compaction/summary → compaction/end` 三个事件按序落盘
- 摘要通过一条带 `surfaceOp: { op: "replace", start, end }` 的 user/message 生效
- 工具大结果先走 pruner 截断，再重新计量
- 摘要失败不留「假完成」的 end 事件
DSH 出处：docs/subsystems/compaction.md、token-meter.md

### E3 permission presets

目标：把 sandbox 模式与审批策略捆成具名预设。
验收：
- `workspace-write` = workspace-write + ask
- `danger-full-access` = danger-full-access + never
- 两个旋钮被单独改动后，当前预设降级为派生的 `custom`
DSH 出处：docs/subsystems/permission-presets.md

### E4 goal 与 /continue

目标：持久完成目标 + Round 上限 + `/continue` 续行。
验收：
- 目标有 active / paused / blocked / complete 四个阶段
- 达到 Round 上限后不再自动续行
- `/continue` 开启新 Round 并生成一个轮次
DSH 出处：docs/subsystems/goal.md

## 简历上怎么写

做完 E1–E4 之后，可以如实写：

- 基于 cordis 从零实现 Coding Agent Harness，把会话、工具、模型、审批、持久化、压缩、目标管理拆成独立插件与可替换 seam
- 实现结构化 tool-calling 全链路：模型流式增量 → tool_call 拼装 → 统一执行接口 → 结果投影回会话日志
- 实现追加式 JSONL 会话持久化与崩溃恢复，支持恢复、列举、删除
- 实现基于 surface 遮蔽的上下文压缩：token 计量 → 工具结果剪枝 → 区间摘要 → 检查点替换
- 实现 sandbox 模式 × 审批策略的权限预设，以及持久 goal 的 Round 续行

并注明参考来源，例如「设计参照 DeepSeek Harness 的公开文档与 cordis 教程」。

## E5：Jev 辅助压缩试验（研究完成，默认关闭）

- 完成：完整摘要输入、重点标记、off/shadow/assisted、失败回退、取消传播与真实对照。
- 完成：简洁 CLI 页头、工具状态、新会话与状态命令。
- 首轮：6 个合成会话；质量指标与修复组持平，Jev 增加约 24% 摘要耗时。
- 未晋级：更多独立会话与重复验证尚未完成，不默认启用。方案与阈值见 `docs/experiments/jev-compaction-pilot.md`。
