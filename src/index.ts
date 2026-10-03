import { Context } from '@deepseek-ai/cordis'
import dotenv from 'dotenv'
import * as agentLoop from './plugins/agent-loop.ts'
import * as agents from './plugins/agents.ts'
import * as approval from './plugins/approval.ts'
import * as cli from './plugins/cli.ts'
import * as compaction from './plugins/compaction.ts'
import * as hello from './plugins/hello.ts'
import * as llm from './plugins/llm.ts'
import * as permissionPresets from './plugins/permission-presets.ts'
import * as persistence from './plugins/persistence.ts'
import * as runtimeContext from './plugins/runtime-context.ts'
import * as sandbox from './plugins/sandbox.ts'
import * as sessions from './plugins/sessions.ts'
import * as systemPrompt from './plugins/system-prompt.ts'
import * as tokenMeter from './plugins/token-meter.ts'
import * as tools from './plugins/tools.ts'
import * as deepseek from './providers/deepseek.ts'
import * as files from './tools/files.ts'
import * as search from './tools/search.ts'
import * as shell from './tools/shell.ts'

// 组合根：所有能力都通过 root.plugin() 挂载，模块之间不直接 import，
// 跨模块通信一律走 ctx.<service>（见 ARCHITECTURE.md 设计原则 1）。
// 环境变量只在这里读取，再以 config 形式传给插件。
dotenv.config({ quiet: true })

const workspace = process.env.TINY_DSH_WORKSPACE ?? process.cwd()
const model = process.env.TINY_DSH_MODEL ?? 'deepseek/deepseek-v4-flash'
const sessionsDir = process.env.TINY_DSH_SESSIONS ?? 'sessions'
const maxTokens = Number(process.env.TINY_DSH_MAX_TOKENS ?? '') || 8000
const permission = process.env.TINY_DSH_PERMISSION ?? 'workspace-write'
const root = new Context()

// 核心 seam：加载顺序由 inject 决定，这里只是可读性。
await root.plugin(sessions)
await root.plugin(persistence, { directory: sessionsDir })
await root.plugin(systemPrompt)
await root.plugin(tokenMeter)
await root.plugin(tools)
await root.plugin(llm)
await root.plugin(compaction, { maxTokens, model })
await root.plugin(approval)
await root.plugin(sandbox, { workspace })
await root.plugin(permissionPresets, { defaultPreset: permission })
await root.plugin(agentLoop)
await root.plugin(agents)

// providers / tools / 场景插件。
await root.plugin(hello)
await root.plugin(runtimeContext, { workspace })
await root.plugin(files)
await root.plugin(search)
await root.plugin(shell)
// 没有 API key 也能启动：provider 只在使用时才校验 key。
await root.plugin(deepseek, {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
})

const session = root.sessions.create({ title: 'boot' })
root.sessions.append(session.id, 'user/message', { content: 'hello' })
const prompt = await root.systemPrompt.assemble()
const toolNames = root.tools
    .schemas()
    .map((schema) => schema.function.name)
    .join(', ')

console.log(`tiny-dsh: ${root.constructor.name} ready`)
console.log(`  ctx.hello.greet('world') -> ${root.hello.greet('world')}`)
console.log(
    `  ctx.sessions -> ${root.sessions.list().length} session(s), ` +
        `${root.sessions.deriveMessages(session.id).length} projected message(s)`,
)
console.log(`  ctx.tools -> ${root.tools.schemas().length} tool(s): ${toolNames}`)
console.log(`  ctx.agents -> ${root.agents.list().length} agent(s), agentLoop ready`)
console.log(
    `  ctx.llm -> ${
        root.llm
            .list()
            .map((provider) => provider.name)
            .join(', ') || '(none)'
    }`,
)
console.log(
    `  ctx.systemPrompt -> ${root.systemPrompt.list().length} fragment(s), ${prompt.length} chars`,
)
console.log(
    `  ctx.sandbox -> ${root.sandbox.mode} + approval/${root.approval.policy} ` +
        `(preset: ${root.permissionPresets.current()}) @ ${root.sandbox.workspace}`,
)
console.log(
    `  ctx.tokenMeter / ctx.compaction -> ~${root.tokenMeter.count(prompt)} tokens now, threshold ${root.compaction.maxTokens}`,
)

// 确认 boot session 已落盘。
await root.persistence.flush()
const persisted = await root.persistence.list()
console.log(
    `  ctx.persistence -> ${persisted.length} file(s) @ ${root.persistence.provider.directory}`,
)

// CLI 最后挂：交互式 TTY 下进入 REPL，否则什么都不做。
await root.plugin(cli, { model, interactive: Boolean(process.stdin.isTTY) })
