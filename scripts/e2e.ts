import { Context } from '@deepseek-ai/cordis'
import dotenv from 'dotenv'
import { goalContinuationPrompt } from '../src/cli/commands.ts'
import * as agentLoop from '../src/plugins/agent-loop.ts'
import * as agents from '../src/plugins/agents.ts'
import * as approval from '../src/plugins/approval.ts'
import * as compaction from '../src/plugins/compaction.ts'
import * as goal from '../src/plugins/goal.ts'
import * as llm from '../src/plugins/llm.ts'
import * as permissionPresets from '../src/plugins/permission-presets.ts'
import * as runtimeContext from '../src/plugins/runtime-context.ts'
import * as sandbox from '../src/plugins/sandbox.ts'
import * as sessions from '../src/plugins/sessions.ts'
import * as systemPrompt from '../src/plugins/system-prompt.ts'
import * as tokenMeter from '../src/plugins/token-meter.ts'
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
 * 可选开关：
 *   TINY_DSH_E2E_TURNS       同一 session 跑多轮（默认 1）
 *   TINY_DSH_MAX_TOKENS      压缩阈值；压小可强制真实摘要（默认 8000）
 *   TINY_DSH_E2E_GOAL        设为目标文本 → 目标模式（验证 Round 上限会停）
 *   TINY_DSH_MAX_GOAL_ROUNDS 目标 Round 上限（默认 2）
 *
 * 脚本只依赖 .env 里的 key，**不会把 key 打印出来**。
 */

dotenv.config({ quiet: true })

const workspace = process.env.TINY_DSH_WORKSPACE ?? process.cwd()
const model = process.env.TINY_DSH_MODEL ?? 'deepseek/deepseek-v4-flash'
const prompt =
    process.argv.slice(2).join(' ') ||
    'List the TypeScript files under src/core with the glob tool, then reply with just the file names.'
// 可选：TINY_DSH_MAX_TOKENS 压到很小 + TINY_DSH_E2E_TURNS 多轮，就能真实触发一次压缩摘要。
const maxTokens = Number(process.env.TINY_DSH_MAX_TOKENS ?? '') || 8000
const turns = Number(process.env.TINY_DSH_E2E_TURNS ?? '') || 1
// 可选：设 TINY_DSH_E2E_GOAL 走目标模式，验证 Round 上限会停住自动续行。
const goalObjective = process.env.TINY_DSH_E2E_GOAL
const maxGoalRounds = Number(process.env.TINY_DSH_MAX_GOAL_ROUNDS ?? '') || 2

const root = new Context()

await root.plugin(sessions)
await root.plugin(goal, { maxGoalRounds })
await root.plugin(systemPrompt)
await root.plugin(tokenMeter)
await root.plugin(tools)
await root.plugin(llm)
await root.plugin(compaction, { model, maxTokens })
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
console.log(`prompt: ${prompt}`)
console.log(`turns=${turns} compactionThreshold=${maxTokens}\n`)

const onReasoning = (chunk: string) => process.stdout.write(`\x1b[2m${chunk}\x1b[0m`)
const onContent = (chunk: string) => process.stdout.write(chunk)

try {
    let stopReason = 'unknown'
    let rounds = 0

    if (goalObjective) {
        // 目标模式：用 nextRound（自动续行路径）跑到 Round 上限，验证上限会停。
        const created = root.goal.set(session.id, goalObjective, { maxGoalRounds })
        let round = root.goal.nextRound(created.id)
        while (round !== undefined) {
            process.stdout.write(`\n--- goal round ${round}/${created.maxGoalRounds} ---\n`)
            const result = await agent.run(goalContinuationPrompt(created, round), {
                onReasoning,
                onContent,
            })
            stopReason = result.stopReason
            rounds += result.rounds
            round = root.goal.nextRound(created.id)
        }
        const final = root.goal.current(session.id)
        console.log(
            `\n\n[goal ${final?.phase} · rounds ${final?.roundsStarted}/${final?.maxGoalRounds}]`,
        )
        console.log(`[nextRound after cap: ${String(root.goal.nextRound(created.id))}]`)
    } else {
        for (let turn = 1; turn <= turns; turn++) {
            const text = turns === 1 ? prompt : `${prompt} (turn ${turn}/${turns})`
            if (turns > 1) process.stdout.write(`\n--- turn ${turn}/${turns} ---\n`)
            const result = await agent.run(text, { onReasoning, onContent })
            stopReason = result.stopReason
            rounds += result.rounds
        }
    }

    const toolResults = session.events.filter((event) => event.type === 'tool/result').length
    const checkpoints = session.events.filter((event) => event.type === 'compaction/summary').length
    console.log(`\n\n[${stopReason} · ${rounds} round(s) · ${toolResults} tool call(s)]`)
    console.log(`[compaction: ${checkpoints} checkpoint(s), threshold ${maxTokens}]`)
    const messages = root.sessions.deriveMessages(session.id)
    console.log(
        `[projected ${messages.length} message(s), ~${root.tokenMeter.countMessages(messages)} tokens]`,
    )
    if (goalObjective) {
        const goalEvents = session.events.filter((event) => event.type === 'goal/change').length
        console.log(`[goal/change events: ${goalEvents}]`)
    }
} catch (error) {
    console.error(`\n[error] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
}
