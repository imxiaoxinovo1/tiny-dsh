import * as readline from 'node:readline/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '../core/agent.ts'
import { isAbortError } from '../core/tool.ts'
import { createApprovalAnswerer } from './answerer.ts'
import { goalContinuationPrompt, runSlashCommand } from './commands.ts'
import { TerminalView } from './ui.ts'

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

export async function startRepl(ctx: Context, options: ReplOptions): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const view = new TerminalView()
    let turnAbort: AbortController | undefined
    const disposeAnswerer = ctx.get('approval')?.setAnswerer(
        createApprovalAnswerer((question) => {
            view.stopThinking()
            return rl.question(question, { signal: turnAbort?.signal })
        }),
    )
    const session = ctx.sessions.create({ title: 'repl' })
    let active = activate(ctx, options.model, session.id)
    let closed = false
    const onInterrupt = () => {
        if (active.agent.running) {
            turnAbort?.abort()
            active.agent.cancel()
        } else rl.close()
    }
    rl.on('SIGINT', onInterrupt)
    process.on('SIGINT', onInterrupt)
    rl.on('close', () => {
        closed = true
        turnAbort?.abort()
        active.agent.cancel()
    })

    const runTurn = async (text: string): Promise<boolean> => {
        const started = performance.now()
        view.beginTurn()
        view.thinking()
        turnAbort = new AbortController()
        const previousObservation = ctx.get('compaction')?.lastObservation
        try {
            const result = await active.agent.run(text, {
                signal: turnAbort.signal,
                onContent: (chunk) => view.content(chunk),
                onAssistant: (response) => {
                    view.stopThinking()
                    for (const call of response.toolCalls) view.tool(call)
                },
                onToolResult: (result) => {
                    view.toolResult(result)
                    view.thinking()
                },
            })
            view.finish(
                result.rounds,
                performance.now() - started,
                result.stopReason === 'maxRounds',
            )
            const observation = ctx.get('compaction')?.lastObservation
            if (observation !== previousObservation && observation?.outcome === 'fallback') {
                view.notice('Jev unavailable · used standard summary')
            }
            return true
        } catch (error) {
            view.notice(
                isAbortError(error)
                    ? 'Cancelled'
                    : error instanceof Error
                      ? error.message
                      : String(error),
                isAbortError(error) ? 'info' : 'error',
            )
            return false
        } finally {
            turnAbort = undefined
            view.stopThinking()
        }
    }

    const driveGoal = async (): Promise<void> => {
        const goal = ctx.get('goal')
        if (!goal) return
        while (!closed) {
            const current = goal.current(active.sessionId)
            if (current?.phase !== 'active') return
            const round = goal.nextRound(current.id)
            if (round === undefined) return
            view.notice(`Goal ${round}/${current.maxGoalRounds}`)
            if (!(await runTurn(goalContinuationPrompt(current, round)))) return
        }
    }

    view.header({
        model: options.model,
        workspace: ctx.get('sandbox')?.workspace ?? process.cwd(),
        permission: ctx.get('permissionPresets')?.current() ?? 'custom',
        semantic: ctx.get('compaction')?.semanticMode ?? 'off',
    })

    try {
        while (!closed) {
            let raw: string
            try {
                raw = await rl.question(view.prompt())
            } catch (error) {
                if (closed) break
                throw error
            }
            const line = raw.trim()
            if (!line) continue
            if (line === '/status') {
                view.header(
                    {
                        model: options.model,
                        workspace: ctx.get('sandbox')?.workspace ?? process.cwd(),
                        permission: ctx.get('permissionPresets')?.current() ?? 'custom',
                        semantic: ctx.get('compaction')?.semanticMode ?? 'off',
                    },
                    true,
                )
                view.notice(`Session ${active.sessionId}`)
                continue
            }
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
                if (command.output) process.stdout.write(`\n${command.output}\n`)
                if (command.exit) break
                if (command.sessionId && command.sessionId !== active.sessionId) {
                    ctx.agents.delete(active.agent.id)
                    active = activate(ctx, options.model, command.sessionId)
                }
                if (!ctx.sessions.get(active.sessionId)) {
                    ctx.agents.delete(active.agent.id)
                    const fresh = ctx.sessions.create({ title: 'repl' })
                    active = activate(ctx, options.model, fresh.id)
                    view.notice('Started a new session')
                }
                if (command.run && !(await runTurn(command.run))) continue
                await driveGoal()
                continue
            }
            if (await runTurn(line)) await driveGoal()
        }
    } finally {
        process.off('SIGINT', onInterrupt)
        disposeAnswerer?.()
        view.stopThinking()
        ctx.agents.delete(active.agent.id)
        rl.close()
        await ctx.get('persistence')?.flush()
    }
}
