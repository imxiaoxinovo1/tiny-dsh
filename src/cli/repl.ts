import * as readline from 'node:readline/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createApprovalAnswerer } from './answerer.ts'
import { runSlashCommand } from './commands.ts'

/** REPL 配置。 */
export interface ReplOptions {
    model: string
}

/** 每个 REPL 一个活跃 session + agent；`/resume` / `/delete` 会切换它们。 */
function activate(ctx: Context, model: string, sessionId: string) {
    return { sessionId, agent: ctx.agents.create({ sessionId, model }) }
}

/**
 * 最小 REPL：输入即 `agent.run()`，支持 `/sessions` `/resume` `/delete` 等斜杠命令。
 *
 * 审批用同一个 readline 实例提问（顺序调用，不会和主循环抢 stdin）。
 */
export async function startRepl(ctx: Context, options: ReplOptions): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    ctx.get('approval')?.setAnswerer(createApprovalAnswerer((question) => rl.question(question)))

    const session = ctx.sessions.create({ title: 'repl' })
    let active = activate(ctx, options.model, session.id)
    const onInterrupt = () => active.agent.cancel()
    process.on('SIGINT', onInterrupt)

    process.stdout.write(`tiny-dsh · model=${options.model}\n/help for commands, /exit to quit.\n`)

    try {
        while (true) {
            const raw = await rl.question('\ntiny-dsh> ')
            const line = raw.trim()
            if (!line) continue

            const command = await runSlashCommand(
                line,
                { sessions: ctx.sessions, persistence: ctx.get('persistence') },
                { sessionId: active.sessionId },
            )
            if (command) {
                if (command.output) process.stdout.write(`${command.output}\n`)
                if (command.exit) break
                if (command.sessionId && command.sessionId !== active.sessionId) {
                    active = activate(ctx, options.model, command.sessionId)
                }
                // 活跃会话被 /delete 删掉时，开一个新的。
                if (!ctx.sessions.get(active.sessionId)) {
                    const fresh = ctx.sessions.create({ title: 'repl' })
                    active = activate(ctx, options.model, fresh.id)
                    process.stdout.write('active session was deleted; started a new one\n')
                }
                continue
            }

            try {
                const result = await active.agent.run(line, {
                    onContent: (chunk) => process.stdout.write(chunk),
                })
                process.stdout.write(`\n[${result.stopReason} · ${result.rounds} round(s)]\n`)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                process.stdout.write(`\n[error] ${message}
`)
            }
        }
    } finally {
        process.off('SIGINT', onInterrupt)
        rl.close()
    }
}
