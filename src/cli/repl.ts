import * as readline from 'node:readline/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '../core/agent.ts'
import { createApprovalAnswerer } from './answerer.ts'
import { goalContinuationPrompt, runSlashCommand } from './commands.ts'

/** REPL 配置。 */
export interface ReplOptions {
    model: string
}

interface ActiveSession {
    sessionId: string
    agent: Agent
}

function activate(ctx: Context, model: string, sessionId: string): ActiveSession {
    return { sessionId, agent: ctx.agents.create({ sessionId, model }) }
}

function write(text: string): void {
    process.stdout.write(text)
}

/**
 * 最小 REPL：输入即 `agent.run()`，支持 E1/E3/E4 的斜杠命令。
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

    const runTurn = async (text: string): Promise<void> => {
        try {
            const result = await active.agent.run(text, { onContent: (chunk) => write(chunk) })
            write(`\n[${result.stopReason} · ${result.rounds} round(s)]\n`)
        } catch (error) {
            write(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`)
        }
    }

    /** 目标仍 active 且没到 Round 上限就自动续行；到上限（nextRound 返回 undefined）就停。 */
    const driveGoal = async (): Promise<void> => {
        const goal = ctx.get('goal')
        if (!goal) return
        while (true) {
            const current = goal.current(active.sessionId)
            if (current?.phase !== 'active') return
            const round = goal.nextRound(current.id)
            if (round === undefined) return
            write(`\n[goal round ${round}/${current.maxGoalRounds}]\n`)
            await runTurn(goalContinuationPrompt(current, round))
        }
    }

    write(`tiny-dsh · model=${options.model}\n/help for commands, /exit to quit.\n`)

    try {
        while (true) {
            const raw = await rl.question('\ntiny-dsh> ')
            const line = raw.trim()
            if (!line) continue

            const command = await runSlashCommand(
                line,
                {
                    sessions: ctx.sessions,
                    persistence: ctx.get('persistence'),
                    permissionPresets: ctx.get('permissionPresets'),
                    goal: ctx.get('goal'),
                },
                { sessionId: active.sessionId },
            )
            if (command) {
                if (command.output) write(`${command.output}\n`)
                if (command.exit) break
                if (command.sessionId && command.sessionId !== active.sessionId) {
                    active = activate(ctx, options.model, command.sessionId)
                }
                // 活跃会话被 /delete 删掉时，开一个新的。
                if (!ctx.sessions.get(active.sessionId)) {
                    const fresh = ctx.sessions.create({ title: 'repl' })
                    active = activate(ctx, options.model, fresh.id)
                    write('active session was deleted; started a new one\n')
                }
                // /continue 开了一个新 Round：把续行提示交给 Agent。
                if (command.run) await runTurn(command.run)
                await driveGoal()
                continue
            }

            await runTurn(line)
            await driveGoal()
        }
    } finally {
        process.off('SIGINT', onInterrupt)
        rl.close()
    }
}
