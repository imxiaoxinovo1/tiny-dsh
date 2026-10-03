import { Context } from '@deepseek-ai/cordis'
import dotenv from 'dotenv'
import * as agentLoop from '../src/plugins/agent-loop.ts'
import * as agents from '../src/plugins/agents.ts'
import * as approval from '../src/plugins/approval.ts'
import * as llm from '../src/plugins/llm.ts'
import * as permissionPresets from '../src/plugins/permission-presets.ts'
import * as runtimeContext from '../src/plugins/runtime-context.ts'
import * as sandbox from '../src/plugins/sandbox.ts'
import * as sessions from '../src/plugins/sessions.ts'
import * as systemPrompt from '../src/plugins/system-prompt.ts'
import * as tools from '../src/plugins/tools.ts'
import * as deepseek from '../src/providers/deepseek.ts'
import * as files from '../src/tools/files.ts'
import * as search from '../src/tools/search.ts'

/**
 * 端到端冒烟：用真实 DeepSeek provider 跑一次带工具往返的 run。
 *
 * 用法：
 *   1. 在仓库根目录建 .env（已被 .gitignore 忽略），写入 DEEPSEEK_API_KEY=...
 *   2. pnpm run e2e ["自定义提示词"]
 *
 * 脚本只依赖 .env 里的 key，**不会把 key 打印出来**。
 */

dotenv.config({ quiet: true })

const workspace = process.env.TINY_DSH_WORKSPACE ?? process.cwd()
const model = process.env.TINY_DSH_MODEL ?? 'deepseek/deepseek-v4-flash'
const prompt =
    process.argv.slice(2).join(' ') ||
    'List the TypeScript files under src/core with the glob tool, then reply with just the file names.'

const root = new Context()

await root.plugin(sessions)
await root.plugin(systemPrompt)
await root.plugin(tools)
await root.plugin(llm)
await root.plugin(approval)
await root.plugin(sandbox, { workspace })
await root.plugin(permissionPresets, { defaultPreset: 'workspace-write' })
await root.plugin(agentLoop)
await root.plugin(agents)
await root.plugin(runtimeContext, { workspace })
await root.plugin(files)
await root.plugin(search)
await root.plugin(deepseek, {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
})

// 非交互：写操作自动批准（本次提示词只读，不会真的用到）。
root.approval.setAnswerer(() => true)

const session = root.sessions.create({ title: 'e2e' })
const agent = root.agents.create({ sessionId: session.id, model })

console.log(`model=${model}`)
console.log(`workspace=${workspace}`)
console.log(`prompt: ${prompt}\n`)

try {
    const result = await agent.run(prompt, {
        onReasoning: (chunk) => process.stdout.write(`\x1b[2m${chunk}\x1b[0m`),
        onContent: (chunk) => process.stdout.write(chunk),
    })
    const toolResults = session.events.filter((event) => event.type === 'tool/result').length
    console.log(
        `\n\n[${result.stopReason} · ${result.rounds} round(s) · ${toolResults} tool call(s)]`,
    )
    const messages = root.sessions.deriveMessages(session.id)
    console.log(
        `[projected ${messages.length} message(s), ~${root.tokenMeter.countMessages(messages)} tokens]`,
    )
} catch (error) {
    console.error(`\n[error] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
}
