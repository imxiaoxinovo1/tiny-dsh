import * as readline from 'node:readline/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createApprovalAnswerer } from './answerer.ts'

/** REPL 配置。 */
export interface ReplOptions {
    model: string
}

/**
 * 最小 REPL：一个 session + 一个 agent，输入即 `agent.run()`。
 *
 * 审批用同一个 readline 实例提问（顺序调用，不会和主循环抢 stdin）。
 */
export async function startRepl(ctx: Context, options: ReplOptions): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    ctx.get('approval')?.setAnswerer(createApprovalAnswerer((question) => rl.question(question)))

    const session = ctx.sessions.create({ title: 'repl' })
    const agent = ctx.agents.create({ sessionId: session.id, model: options.model })
    const onInterrupt = () => agent.cancel()
    process.on('SIGINT', onInterrupt)

    process.stdout.write(`tiny-dsh · model=${options.model}\n/help for commands, /exit to quit.\n`)

    try {
        while (true) {
            const raw = await rl.question('\ntiny-dsh> ')
            const line = raw.trim()
            if (!line) continue
            if (line === '/exit' || line === '/quit') break
            if (line === '/help') {
                process.stdout.write('/help  /clear  /exit\n')
                continue
            }
            if (line === '/clear') {
                ctx.sessions.clear(session.id)
                process.stdout.write('session cleared\n')
                continue
            }

            try {
                const result = await agent.run(line, {
                    onContent: (chunk) => process.stdout.write(chunk),
                })
                process.stdout.write(`\n[${result.stopReason} · ${result.rounds} round(s)]\n`)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                process.stdout.write(`\n[error] ${message}\n`)
            }
        }
    } finally {
        process.off('SIGINT', onInterrupt)
        rl.close()
    }
}
