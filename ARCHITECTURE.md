# tiny-dsh 架构

一个从零实现的、基于 cordis 的最小 Coding Agent Harness。

设计参照 DeepSeek Harness（DSH）的能力 seam 划分方式。它不是 DSH 的分支，也不包含 DSH 或任何其它项目的源码。

## 一句话

```
Agent = Model + Harness
```

Harness 只做三件事：

1. 把会话历史组织成模型能消费的请求（Session / Prompt / Context）
2. 把模型返回的结构化 tool_call 安全执行掉（Tool / Approval / Sandbox）
3. 在两者之间循环，直到模型不再请求工具（Agent Loop）

## 五条设计原则

1. **一切皆插件。** 除组合根 `src/index.ts` 外，模块之间不直接 import，跨模块通信一律走 `ctx.<service>`。
2. **seam 三段式。** 每个能力拆成 Definition（接口与类型）、Provider（实现）、Consumer（使用方）。换 Provider 不改 Consumer。
3. **会话是事实，消息是投影。** Session 只 append 事件；发给模型的 messages 每次由 `deriveMessages()` 现场投影，不单独维护一份。
4. **能力可选。** 持久化、压缩、审批、goal 都是插件，可以单独卸载；卸载后核心链路仍能跑。
5. **默认拒绝。** 写文件和 shell 必须先过审批；没有审批通道时 fail closed，而不是放行。

## 目录结构

```
src/
  index.ts          组合根：建立 Context，按依赖顺序加载插件
  core/             纯逻辑运行时，不 import cordis
    session.ts      事件日志 + deriveMessages()
    tool.ts         工具注册表 + 执行流水线
    llm.ts          Provider 注册表
    prompt.ts       system prompt 的 section / context 组装
    agent.ts        Agent 句柄（session + model + loop）
    loop.ts         Agent Loop
    path.ts         workspace 路径闸门
  plugins/          把 core 包成 cordis Service，并负责接线
  providers/        可替换实现：deepseek / jsonl-persistence
  tools/            read_file write_file edit_file glob grep shell
  cli/              REPL、斜杠命令、渲染、审批 answerer
test/               每个 runtime 一个行为测试文件
```

## 依赖方向

```
cli ──▶ plugins ──▶ core
           │
           └────▶ providers ──▶ core
```

`core` 不依赖任何上层；`plugins` 把 `core` 挂到 Context 上；`providers` 实现 seam 的某一侧。

## seam 清单

| service | Definition 职责 | Provider | Consumer | 里程碑 |
|---|---|---|---|---|
| `ctx.sessions` | 追加式事件日志 | 内存 | loop、cli | D2 |
| `ctx.persistence` | 会话落盘 / 恢复 | JSONL | sessions、cli | E1 |
| `ctx.tools` | 工具注册、schema、执行 | bash、files | loop | D3 |
| `ctx.llm` | Provider 注册与路由 | deepseek、mock | loop | D4 |
| `ctx.systemPrompt` | section / context 组装 | — | loop、cli | D6 |
| `ctx.agents` | Agent 注册表 | — | cli | D5 |
| `ctx.agentLoop` | model → tool → model 推进 | — | agents | D5 |
| `ctx.approval` | 审批请求与结果 | CLI answerer | tools | D7 / E3 |
| `ctx.sandbox` | 路径闸门 + 命令策略 | — | tools | D7 / E3 |
| `ctx.permissionPresets` | sandbox 模式 × 审批策略的具名捆绑 | — | cli | E3 |
| `ctx.tokenMeter` | token 估算 | 估算器 | compaction | E2 |
| `ctx.compaction` | 阈值压缩 | basic-compaction | loop | E2 |
| `ctx.goal` | 持久目标 + Round | — | cli | E4 |

## 核心数据结构

```ts
type SessionEvent = { seq: number; type: string; data: unknown; at: string }

type ModelRequest = {
    model: string
    system: string
    messages: ChatMessage[]
    tools: ToolSchema[]
    signal?: AbortSignal
    onReasoning?: (chunk: string) => void
    onContent?: (chunk: string) => void
}

type ModelResponse = {
    content: string
    reasoningContent?: string
    toolCalls: { id: string; name: string; arguments: unknown }[]
}

type ToolDefinition = {
    name: string
    description: string
    parameters: JsonSchema
    execute(args: unknown, exec: ToolExecution): Promise<unknown>
    render?(args: unknown, value: unknown): ContentBlock[]
}
```

## 关键不变式

1. **tool_call 必须配对。** 一次 run 被取消时，仍要给每一个 tool_call 补一条 tool/result。否则投影出的 assistant 消息里有 tool_calls、却没有对应的 tool 回复，此后该 session 的每一次请求都会被服务端拒绝。
2. **tool/result 的 toolCallId 必须与 assistant/tool_calls 一一对应。**
3. **审批拒绝不得换一种写法重试。**
4. **system prompt 每一步重新组装。** 时间、cwd 属于 harness 状态，不是模型知识。
5. **事件只追加，不改写。** 压缩这类操作通过新事件 + surfaceOp 遮蔽旧区间来表达，而不是删除历史。

## 总体实现设计（v1）

> 这一节把上面的五条原则落成可执行的结构：运行时形状、组合根与加载顺序、每个 seam 的接口草案、一次 run 的数据流、取消/审批语义、测试策略，以及里程碑到文件的映射。
> D2 之后以本节为契约：实现与本节冲突时，先改本节，再改代码。

### 1. 运行时形状

```
        ┌──────────────────────────────────────────────┐
        │ src/index.ts  组合根（唯一 import 各插件处）    │
        └───────────────────┬──────────────────────────┘
                            │ root.plugin(mod, config)
        ┌───────────────────▼──────────────────────────┐
        │ cordis Context：ctx.<service> 服务注册表       │
        └───────┬───────────────────────────┬──────────┘
                │ 包装                       │ 注入
        ┌───────▼────────┐          ┌───────▼──────────┐
        │ src/plugins/*  │─────────▶│ src/providers/*  │
        │ Service 适配层  │          │ 可替换实现         │
        └───────┬────────┘          └───────┬──────────┘
                │ import（单向）             │ import
        ┌───────▼───────────────────────────▼──────────┐
        │ src/core/*  纯逻辑，不 import cordis           │
        └───────────────────────────────────────────────┘
```

依赖规则，按优先级：

1. `core/` 只依赖 Node 标准库与自身类型，导出普通类/函数；文件里不出现 `Context`、`Service`、`ctx`。
2. `plugins/` 是**唯一**把 core 包成 Service 的地方，一个 seam 一个文件（未来可按 seam 拆目录，但不新增 import 边）。
3. `providers/`、`tools/` 通过 `inject` 消费 `ctx.*`，实现 seam 的某一侧。
4. `cli/` 只消费 Service，不 import core。
5. `src/index.ts` 是唯一同时 import 多个插件的地方。

**为什么 core 不 import cordis**：session 投影、工具流水线、agent loop 可以用 `node --test` 直接单测，不必构造 Context；Service/effect 生命周期集中在插件层，替换 cordis 不动 core。

### 2. 组合根与加载顺序

加载顺序由 `inject` 决定，而不是 `plugin()` 的调用顺序；下面的顺序只是「从上往下读就知道谁依赖谁」的推荐写法（与 D1 的 `src/index.ts` 一致，后续里程碑往里追加）：

```ts
root.plugin(sessions)                    // 无依赖：追加式事件日志
root.plugin(systemPrompt)                // 无依赖：section / context 组装
root.plugin(tools)                       // 无依赖：工具注册表
root.plugin(llm)                         // 无依赖：Provider 注册表
root.plugin(approval)                    // 无依赖：审批通道（answerer 后注册）
root.plugin(sandbox, { workspace })      // 无依赖：路径闸门 + 命令策略
root.plugin(tokenMeter)                  // 无依赖：token 估算
root.plugin(compaction)                  // inject tokenMeter, sessions
root.plugin(permissionPresets)           // inject sandbox, approval（E3）
root.plugin(agents)                      // inject sessions, tools, llm, systemPrompt
root.plugin(agentLoop)                   // inject agents
root.plugin(persistence)                 // inject sessions（E1）
root.plugin(goal)                        // inject sessions（E4）

// providers / tools / cli 最后挂：它们消费上面的服务，不提供核心 seam
root.plugin(deepseekProvider)
root.plugin(filesTools, { workspace })
root.plugin(shellTool, { workspace })
root.plugin(cli, { model })
```

未声明的能力（如 E2 的 `compaction` 被卸载）不应让核心链路起不来：`agent-loop` 不得 `inject` 可选能力，而是在使用点 `ctx.get('compaction')` 探测。

### 3. seam 契约草案

Definition 只放接口与类型；Provider 是实现；Consumer 通过 `ctx.<service>` 使用。以下签名是 D2–E4 的目标形态，实现时允许补字段，不允许改语义。

```ts
// ---------- D2 ctx.sessions ----------
interface SessionsService {
    create(meta?: { title?: string }): Session
    get(id: string): Session | undefined
    list(): SessionMeta[]
    delete(id: string): void
    clear(id: string): void                 // 清空事件，id 与 createdAt 不变
    append(id: string, type: string, data: unknown): SessionEvent
    deriveMessages(id: string): ChatMessage[]   // 每次现算，不缓存
}

// ---------- E1 ctx.persistence ----------
interface PersistenceService {
    list(): Promise<SessionMeta[]>
    resume(id: string): Promise<Session | undefined>   // 读盘并放回 store
    delete(id: string): Promise<boolean>
    flush(): Promise<void>                            // 等待排队写入落盘
}
// 方向：persistence 订阅 sessions（store.observe），而不是 sessions 依赖它。
// 首行 SessionHeader，之后一行一个事件；半行由 decodeSessionFile 跳过。

// ---------- D3 ctx.tools ----------
interface ToolsService {
    register(definition: ToolDefinition): () => void      // disposer
    get(name: string): ToolDefinition | undefined
    schemas(): ToolSchema[]                                // OpenAI function 形态
    execute(call: ToolCall, exec: ToolExecutionContext): Promise<ToolResult>
}

interface ToolExecutionContext {
    sessionId: string
    cwd: string
    signal: AbortSignal
    approval?: ApprovalService
    sandbox?: SandboxService
}

// ---------- D4 ctx.llm ----------
interface LlmService {
    register(provider: LlmProvider): () => void
    complete(request: ModelRequest): Promise<ModelResponse>   // 内部完成流式增量拼装
}

interface LlmProvider {
    name: string                              // 'deepseek'
    stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>
}

// ---------- D5 ctx.agents / ctx.agentLoop ----------
interface AgentsService {
    create(meta: { model: string; workspace: string }): Agent
    get(id: string): Agent | undefined
    list(): AgentMeta[]
}

interface Agent {
    readonly id: string
    readonly sessionId: string
    run(input: string, options?: { signal?: AbortSignal }): Promise<RunResult>
    cancel(): void
}

interface RunResult {
    sessionId: string
    stopReason: 'assistant' | 'maxRounds'   // 取消先补齐事件日志，再抛 AbortError
    rounds: number
}

// ---------- D6 ctx.systemPrompt ----------
interface SystemPromptService {
    section(definition: PromptSection): () => void   // 静态文本或工厂
    context(definition: PromptContext): () => void   // 必须是工厂，每步重算
    list(): PromptEntryInfo[]
    assemble(): Promise<string>               // 每次重新调用动态片段
}

interface PromptSection {
    name: string
    order?: number                            // 越小越靠前；同级按注册顺序
    text: string | (() => string | Promise<string>)
}

interface PromptContext extends Omit<PromptSection, 'text'> {
    text: () => string | Promise<string>
}

// ---------- D7 ctx.approval / ctx.sandbox ----------
interface ApprovalService {
    request(request: ApprovalRequest): Promise<'allow' | 'deny'>
    setAnswerer(answerer: (request: ApprovalRequest) => Promise<boolean>): () => void
    policy: 'ask' | 'never'      // never = 不询问任何人，直接拒绝（DSH 语义）
    setPolicy(policy: 'ask' | 'never'): void
}

interface SandboxService {
    mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    readonly workspace: string
    setMode(mode: SandboxMode): void
    resolvePath(path: string, intent: 'read' | 'write'): Promise<string>   // 越界即 reject
    checkCommand(command: string): Promise<void>
}
// danger-full-access 下 sandbox 已放行全部路径，工具不再触发审批：
// 这就是 danger-full-access = full-access + never 能自洽的原因。

// ---------- E3 ctx.permissionPresets ----------
interface PermissionPresetsService {
    list(): PermissionPreset[]
    current(): string                     // 生效的预设名，或派生的 'custom'
    resolve(name: string): PermissionPreset
    select(name: string): void            // 一次写两个旋钮
    setMode(mode: SandboxMode): void      // 单独改旋钮 → current() 可能降级 custom
    setPolicy(policy: 'ask' | 'never'): void
}
// 默认表：workspace-write = workspace-write + ask；
//          danger-full-access = danger-full-access + never。
// 'custom' / 'auto' 是保留名，不可作为可配置预设。

// ---------- E2 ctx.tokenMeter / ctx.compaction ----------
interface TokenMeterService {
    count(text: string): number
    countMessages(messages: ChatMessage[]): number
    countRequest(request: ModelRequest): number
}

interface CompactionService {
    prepare(sessionId: string): Promise<ChatMessage[]>  // 剪枝 + 必要时摘要后的消息
    maybeCompact(sessionId: string): Promise<boolean>   // true 表示写入了一次压缩检查点
    readonly maxTokens: number
}
// 链路：token 计量 → 大工具结果 pruner 截断并重新计量 → 仍超阈值则摘要旧区间。
// 检查点是 start → summary → user/message(surfaceOp) → end；摘要失败不写 end。

// ---------- E4 ctx.goal ----------
interface GoalService {
    set(sessionId: string, objective: string, options?: { maxGoalRounds?: number }): Goal
    get(id: string): Goal | undefined
    current(sessionId: string): Goal | undefined
    pause(id: string): Goal
    resume(id: string): Goal
    complete(id: string): Goal
    block(id: string, reason: GoalBlockReason): Goal
    canContinue(id: string): boolean
    nextRound(id: string): number | undefined   // 自动续行；到 Round 上限返回 undefined
    continueRound(id: string): number           // /continue；不满足条件抛错
    restore(sessionId: string): Goal | undefined // 从 goal/change 事件折出快照
}
// phase: active | paused | blocked | complete；blockedReason 只在 blocked 时存在。
// 目标是持久的：每次变更写一条 goal/change 事件（含完整快照），E1 把它落盘。
```

命名约定：Service 名用小写单数（`sessions`、`tools`、`llm`）；事件名用 `domain/action`（`user/message`、`assistant/tool_calls`、`tool/result`、`compaction/start`、`goal/change`）。

### 4. 一次 run 的数据流

```
cli/agents.run(input)
  │
  ├─ append  user/message
  │
  └─ loop（最多无固定步数上限，直到模型不再请求工具）
       │
       ├─ systemPrompt.assemble()          // 每步重算：时间 / cwd 保持新鲜
       ├─ sessions.deriveMessages(id)      // 从事件日志现场投影
       ├─ llm.complete({ system, messages, tools })
       │     └─ provider.stream() → SSE 增量 → 拼装 content / reasoning / tool_calls
       │
       ├─ append assistant/(message | tool_calls)
       │
       ├─ for each tool_call:              // 必须两两配对，见不变式 1
       │      sandbox.resolvePath / checkCommand
       │      approval.request             // 无通道则 fail closed
       │      tools.execute
       │      append tool/result
       │
       └─ 若本轮没有 tool_calls → stop，返回 assistant/message
```

### 5. 事件与投影

- 事件是事实：`{ seq, type, data, at }`，**只追加，不改写**。
- 消息是投影：`deriveMessages(session)` 把事件折叠成 `ChatMessage[]`，不缓存、不落盘。
- 投影规则：
  - `assistant/tool_calls` → 一条带 `tool_calls` 的 assistant 消息；`arguments` 在投影时重新 `JSON.stringify`。
  - `assistant/tool_calls` 同时保留 `reasoningContent`，与 `content` 一起投影。
  - `tool/result` → 一条 role=`tool` 的消息，`tool_call_id` 必须能对上前一条 assistant 的某个 `tool_call`。
  - `surfaceOp: { op:'replace', start, end }` 的 user/message 在投影时遮蔽被替换区间（E2 压缩）。
- 一轮 run 被取消时，**先补齐事件日志**（给每个 tool_call 写一条 tool/result），再向上抛，保证任何时刻的投影都是合法请求。

### 6. 取消、错误、审批

- **取消**：`AbortSignal` 从 Agent 传到 `llm.complete` 与每个 `tools.execute`；取消只发生在一个 tool 批次结束之后，或在一个批次内补完所有 tool/result 之后。
- **工具错误**：`execute` 内部抛错一律收敛成 `isError: true` 的 `tool/result`，不打断整个 run；只有 `AbortError` 穿透。
- **未知工具**：返回 `isError: true`，不抛异常。
- **审批**：`approval` 无 answerer 时按 `deny` 处理（fail closed）；被拒绝的操作不得换一种写法重试。
- **路径**：`sandbox.resolvePath` 先 `realpath` 再判断是否落在 workspace 内，`../`、绝对路径、指向外部的软链一律拒绝。

### 7. 配置约定

- 每个插件可以有 `Config`（standard-schema）与 `inject`；配置在 fiber 激活前校验，校验失败是 `ValidationError`（可读、带字段路径）。
- 环境变量只在组合根读取（`dotenv`），再以 config 形式传给插件；插件内部不直接读 `process.env`。
- workspace 默认 `process.cwd()`，可用 `TINY_DSH_WORKSPACE` 覆盖；model 默认 `TINY_DSH_MODEL`。

### 8. 测试策略

- `test/<runtime>.test.ts` 一个 core runtime 一个文件，`node:test` + `node:assert/strict`。
- core 测试直接 `new` 被测对象，不需要 Context。
- 插件测试用 `new Context()` + `ctx.plugin(mod)`，必要时用测试内联的 mock provider/answerer。
- 每个里程碑的验收场景先写成测试名，再写实现（「卡住时先写测试」）。
- 不变式（tool_call 配对、surfaceOp 遮蔽、fail closed）都要有对应的回归用例。

### 9. 里程碑 → 文件

| 里程碑 | 新增文件 | 依赖的 seam |
|---|---|---|
| D1 | `src/plugins/hello.ts`、`test/plugin.test.ts` | — |
| D2 | `src/core/session.ts`、`src/plugins/sessions.ts`、`test/session.test.ts` | — |
| D3 | `src/core/message.ts`（共享消息类型）、`src/core/tool.ts`、`src/plugins/tools.ts`、`test/tool.test.ts` | `ctx.tools` |
| D4 | `src/core/llm.ts`、`src/plugins/llm.ts`、`src/providers/deepseek.ts`、`test/llm.test.ts` | `ctx.llm` |
| D5 | `src/core/agent.ts`、`src/core/loop.ts`、`src/plugins/agents.ts`、`src/plugins/agent-loop.ts`、`test/loop.test.ts` | `ctx.sessions`、`ctx.tools`、`ctx.llm`、`ctx.systemPrompt` |
| D6 | `src/core/prompt.ts`、`src/plugins/system-prompt.ts`、`src/plugins/runtime-context.ts`、`test/prompt.test.ts` | `ctx.systemPrompt` |
| D7 | `src/core/path.ts`、`src/tools/{guard,files,search,shell}.ts`、`src/plugins/{sandbox,approval,cli}.ts`、`src/cli/{answerer,repl}.ts`、`test/{path,tools}.test.ts` | `ctx.sandbox`、`ctx.approval` |
| E1 | `src/core/persistence.ts`、`src/providers/jsonl-persistence.ts`、`src/plugins/persistence.ts`、`src/cli/commands.ts`、`test/persistence.test.ts` | `ctx.sessions` → `ctx.persistence` |
| E2 | `src/core/token.ts`、`src/core/compaction.ts`、`src/plugins/{token-meter,compaction}.ts`、`test/compaction.test.ts` | `ctx.sessions`、`ctx.tokenMeter` |
| E3 | `src/core/permission-preset.ts`、`src/plugins/permission-presets.ts`、`test/permissions.test.ts` | `ctx.sandbox`、`ctx.approval` |
| E4 | `src/core/goal.ts`、`src/plugins/goal.ts`、`test/goal.test.ts` | `ctx.sessions` |

### 10. 架构决策记录（ADR）

| # | 决策 | 理由 |
|---|---|---|
| A1 | core 不 import cordis | 核心链路可脱离框架单测；换内核不动逻辑 |
| A2 | Session 存事件、消息靠投影 | 压缩/恢复/审计都只需要事件流；不会出现「消息与事件不一致」 |
| A3 | 每 step 重新组装 system prompt | 时间、cwd、goal 属于 harness 状态，不是模型知识 |
| A4 | 可选能力用 `ctx.get()` 探测，不写进 `inject` | 卸载 compaction/goal 后核心链路仍能跑（原则 4） |
| A5 | 没有审批通道 = 拒绝 | 默认拒绝优于默认放行（原则 5） |
| A6 | 取消前先补事件日志 | 保证「任何时刻的投影都是合法请求」（不变式 1） |

### 11. 文件索引

**阅读顺序**：`src/index.ts` → `core/session.ts` → `core/tool.ts` → `core/llm.ts` → `core/loop.ts` → `core/prompt.ts` → `plugins/agent-loop.ts` → 再按兴趣看 `persistence` / `compaction` / `goal`。

#### `src/core/` —— 纯逻辑，不 import cordis（可独立单测）

| 文件 | 职责 | 里程碑 |
|---|---|---|
| `message.ts` | 共享类型：`ChatMessage` / `ToolCall` / `ContentBlock` / `JsonSchema` | D3 |
| `session.ts` | 事件日志、`Session`、`SessionStore`（observe/adopt）、`deriveMessages()`（折 reset 与 `surfaceOp` 遮蔽） | D2 / E2 |
| `tool.ts` | `ToolDefinition` / `ToolResult` / `ToolRegistry`；`ApprovalPort` / `SandboxPort` / `SandboxMode` | D3 / D7 |
| `llm.ts` | `SseParser`、`ModelAssembler`、`parseChatCompletionChunk`、`LlmRuntime` 路由 | D4 |
| `loop.ts` | `AgentLoopRuntime`：model → tool → model；取消先补齐 tool/result 再抛 | D5 |
| `agent.ts` | `Agent`（run/cancel/running）+ `AgentRuntime` 注册表 | D5 |
| `prompt.ts` | `SystemPromptRuntime`：section / context、order、每步重算 | D6 |
| `path.ts` | `PathGate`：词法拒绝绝对路径与越界，`realpath` 拒绝软链逃逸 | D7 |
| `persistence.ts` | JSONL 编解码：首行 header、逐行事件、**容错半行** | E1 |
| `token.ts` | token 估算（宽字符更重）、消息 / 请求计量 | E2 |
| `compaction.ts` | tool-result pruner、区间选择（不切开 tool 配对）、`CompactionRuntime.prepare/maybeCompact` | E2 |
| `permission-preset.ts` | 预设表、`derivePreset`（不匹配即 `custom`）、保留名校验 | E3 |
| `goal.ts` | `GoalRuntime`：四阶段 + Round 配额；`nextRound`（自动）/ `continueRound`（显式） | E4 |

#### `src/plugins/` —— Service 适配层（唯一 import cordis 的地方）

| 文件 | 提供 | 备注 |
|---|---|---|
| `sessions.ts` | `ctx.sessions` | 薄代理到 `SessionStore` |
| `tools.ts` | `ctx.tools` | `register` 绑定**调用方** fiber |
| `llm.ts` | `ctx.llm` | 同上 |
| `agent-loop.ts` | `ctx.agentLoop` | 可选探测 systemPrompt / approval / sandbox / compaction |
| `agents.ts` | `ctx.agents` | runner 委托 `ctx.agentLoop` |
| `system-prompt.ts` | `ctx.systemPrompt` | `section` / `context` 绑定调用方 fiber |
| `runtime-context.ts` | — | 身份 section + 环境 context（时间 / cwd / 平台） |
| `approval.ts` | `ctx.approval` | 默认拒绝；`never` = 不询问直接拒绝 |
| `sandbox.ts` | `ctx.sandbox` | 包装 `PathGate`；`setMode` |
| `permission-presets.ts` | `ctx.permissionPresets` | `select` 一次写两个旋钮 |
| `persistence.ts` | `ctx.persistence` | **订阅** sessions，而非被 sessions 依赖 |
| `token-meter.ts` | `ctx.tokenMeter` | 无状态 |
| `compaction.ts` | `ctx.compaction` | 默认摘要器走 `ctx.llm`（llm 不进 inject） |
| `goal.ts` | `ctx.goal` | 每次变更写 `goal/change` 快照事件 |
| `cli.ts` | — | 仅 TTY 下启动 REPL |
| `hello.ts` | `ctx.hello` | D1 教学插件 |

#### `src/providers/`

| 文件 | 职责 |
|---|---|
| `deepseek.ts` | Chat Completions 流式 provider；`fetch` 可注入；缺 key / HTTP 错误可读 |
| `jsonl-persistence.ts` | 每会话一文件；写入串行化队列 + `flush()`；id 白名单防目录穿越 |

#### `src/tools/`

| 文件 | 职责 |
|---|---|
| `guard.ts` | 审批 / 沙箱守卫与参数读取；**缺能力 fail closed**；full-access 下不触发审批 |
| `files.ts` | `read_file` / `write_file` / `edit_file` |
| `search.ts` | `glob` / `grep`（自带递归遍历 + glob→RegExp，无额外依赖） |
| `shell.ts` | `shell`；超时 + 输出截断双保险；`CommandRunner` 可注入 |

#### `src/cli/`

| 文件 | 职责 |
|---|---|
| `commands.ts` | 斜杠命令纯函数：`/sessions` `/resume` `/delete` `/permissions` `/goal` `/continue` |
| `repl.ts` | 最小 REPL；目标 active 且未到上限时自动续行 |
| `answerer.ts` | `[Y/n]` 审批回答（空回车 / y 通过） |

#### 测试文件

| 测试 | 覆盖 |
|---|---|
| `plugin.test.ts` | D1：Context / Plugin / Service / effect / disposer / inject |
| `session.test.ts` | D2：投影、arguments 重新序列化、reasoning 保留、clear |
| `tool.test.ts` | D3：schema 白名单、未知工具、错误收敛、effect 归属 |
| `llm.test.ts` | D4：SSE 边界、分片拼装、路由、provider 端到端（fake fetch） |
| `loop.test.ts` | D5：工具往返、取消配对、20 轮无上限、错误收敛 |
| `prompt.test.ts` | D6：order、空片段、每步重算、与 loop 集成 |
| `path.test.ts` / `tools.test.ts` | D7：闸门与软链、审批 fail closed、超时 / 截断、glob / grep |
| `persistence.test.ts` | E1：落行、半行容忍、重启恢复、斜杠命令 |
| `compaction.test.ts` | E2：事件顺序、surfaceOp 投影、pruner、失败无 end、loop 集成 |
| `permissions.test.ts` | E3：预设映射、派生 custom、never 语义、工具集成 |
| `goal.test.ts` | E4：阶段迁移、Round 上限、事件持久化与恢复、CLI |

真实端到端见 `scripts/e2e.ts`（`pnpm run e2e`）。

## 与 DSH 的对应

| tiny-dsh | DSH 出处 |
|---|---|
| session 事件日志 / deriveMessages | docs/subsystems/session.md |
| JSONL 持久化 / session flush | docs/subsystems/persistence.md |
| 工具执行流水线 | docs/subsystems/tools.md |
| 审批 seam | docs/subsystems/approval.md |
| sandbox 模式 × 审批策略 | docs/subsystems/sandbox.md、permission-presets.md |
| 压缩 / toolResultPruner / tokenMeter | docs/subsystems/compaction.md、token-meter.md |
| goal 与 Round 上限 | docs/subsystems/goal.md |
| cordis 插件与 Service | docs/cordis-tutorial/ |

## 可选语义压缩与终端展示

`src/core/semantic-compaction.ts` 定义重要性判断端口、完整会话序列化及组合摘要器；`src/providers/jev.ts` 实现 TypeSafe Score HTTP 接入。`plugins/compaction.ts` 组装判断与 DeepSeek 摘要，core 不依赖网络或 cordis。Jev 只标记重点，不决定事件删除、审批或工具配对边界；默认关闭。`src/cli/ui.ts` 负责紧凑终端输出、工具状态与纯文本回退。实验方案见 `docs/experiments/jev-compaction-pilot.md`。
