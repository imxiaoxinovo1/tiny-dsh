import type { SessionMeta } from '../core/session.ts'

/**
 * E1：CLI 斜杠命令。抽成不依赖 readline 的纯函数，便于单测。
 *
 * 返回 `undefined` 表示「不是斜杠命令」，交给 Agent 处理。
 */

/** 命令用到的 session 能力。 */
export interface CommandSessionsPort {
    create(meta?: { title?: string }): { id: string }
    clear(id: string): void
}

/** 命令用到的持久化能力；未挂载时为 undefined。 */
export interface CommandPersistencePort {
    list(): Promise<SessionMeta[]>
    resume(id: string): Promise<{ id: string } | undefined>
    delete(id: string): Promise<boolean>
}

/** 命令用到的权限预设能力；未挂载时为 undefined。 */
export interface CommandPresetsPort {
    current(): string
    list(): { name: string; sandbox: string; approval: string }[]
    select(name: string): void
}

/** 命令用到的目标能力；未挂载时为 undefined。 */
export interface CommandGoalView {
    id: string
    objective: string
    phase: string
    roundsStarted: number
    maxGoalRounds: number
    blockedReason?: { code: string; message: string }
}

export interface CommandGoalPort {
    current(sessionId: string): CommandGoalView | undefined
    set(sessionId: string, objective: string): CommandGoalView
    pause(id: string): void
    resume(id: string): void
    complete(id: string): void
    block(id: string, reason: { code: string; message: string }): void
    continueRound(id: string): number
}

export interface CommandPorts {
    sessions: CommandSessionsPort
    persistence?: CommandPersistencePort
    permissionPresets?: CommandPresetsPort
    goal?: CommandGoalPort
}

/** 当前活跃会话。 */
export interface CommandState {
    sessionId: string
}

export interface CommandResult {
    /** 要打印的文本。 */
    output: string
    /** 退出 REPL。 */
    exit?: boolean
    /** 切换到另一个会话（/resume）。 */
    sessionId?: string
    /** 需要交给 Agent 跑一轮的文本（/continue）。 */
    run?: string
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** /continue 发给模型的续行提示。 */
export function goalContinuationPrompt(
    goal: { objective: string; maxGoalRounds: number },
    round: number,
): string {
    return `Continue working toward the goal: ${goal.objective} (round ${round}/${goal.maxGoalRounds}).`
}

function formatGoal(goal: CommandGoalView): string {
    const lines = [
        `goal ${goal.id}`,
        `  phase: ${goal.phase}`,
        `  rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
        `  objective: ${goal.objective}`,
    ]
    if (goal.blockedReason) {
        lines.push(`  blocked: ${goal.blockedReason.code} - ${goal.blockedReason.message}`)
    }
    return lines.join('\n')
}

function formatMeta(meta: SessionMeta): string {
    const title = meta.title ? `  ${meta.title}` : ''
    return `${meta.id}  ${meta.createdAt}  ${meta.eventCount} event(s)${title}`
}

/** 执行一条斜杠命令；非斜杠命令返回 undefined。 */
export async function runSlashCommand(
    line: string,
    ports: CommandPorts,
    state: CommandState,
): Promise<CommandResult | undefined> {
    const parts = line.trim().split(/\s+/)
    const command = parts[0] ?? ''
    const argument = parts[1]

    switch (command) {
        case '/help':
            return {
                output: '/help  /sessions  /resume <id>  /delete <id>  /clear  /permissions  /permission <name>  /goal [<objective>|pause|resume|complete|block <reason>]  /continue  /exit',
            }

        case '/exit':
        case '/quit':
            return { output: '', exit: true }

        case '/clear':
            ports.sessions.clear(state.sessionId)
            return { output: 'session cleared' }

        case '/sessions': {
            if (!ports.persistence) return { output: 'persistence is not enabled' }
            const metas = await ports.persistence.list()
            if (metas.length === 0) return { output: 'no persisted sessions' }
            return { output: metas.map(formatMeta).join('\n') }
        }

        case '/resume': {
            if (!ports.persistence) return { output: 'persistence is not enabled' }
            if (!argument) return { output: 'usage: /resume <id>' }
            const resumed = await ports.persistence.resume(argument)
            if (!resumed) return { output: `session "${argument}" not found` }
            return { output: `resumed ${resumed.id}`, sessionId: resumed.id }
        }

        case '/delete': {
            if (!ports.persistence) return { output: 'persistence is not enabled' }
            if (!argument) return { output: 'usage: /delete <id>' }
            const removed = await ports.persistence.delete(argument)
            return { output: removed ? `deleted ${argument}` : `session "${argument}" not found` }
        }

        case '/permissions': {
            const presets = ports.permissionPresets
            if (!presets) return { output: 'permission presets are not enabled' }
            const current = presets.current()
            const rows = presets.list().map((preset) => {
                const marker = preset.name === current ? '*' : ' '
                return `${marker} ${preset.name}  (${preset.sandbox} + ${preset.approval})`
            })
            return { output: [`current: ${current}`, ...rows].join('\n') }
        }

        case '/permission': {
            const presets = ports.permissionPresets
            if (!presets) return { output: 'permission presets are not enabled' }
            if (!argument) return { output: 'usage: /permission <name>' }
            try {
                presets.select(argument)
            } catch (error) {
                return { output: error instanceof Error ? error.message : String(error) }
            }
            return { output: `permission -> ${presets.current()}` }
        }

        case '/goal': {
            const goalPort = ports.goal
            if (!goalPort) return { output: 'goals are not enabled' }
            const current = goalPort.current(state.sessionId)

            if (!argument) {
                return { output: current ? formatGoal(current) : 'no goal for this session' }
            }

            if (argument === 'pause' || argument === 'resume' || argument === 'complete') {
                if (!current) return { output: 'no goal for this session' }
                try {
                    if (argument === 'pause') goalPort.pause(current.id)
                    else if (argument === 'resume') goalPort.resume(current.id)
                    else goalPort.complete(current.id)
                } catch (error) {
                    return { output: errorText(error) }
                }
                return {
                    output: `goal -> ${goalPort.current(state.sessionId)?.phase ?? 'unknown'}`,
                }
            }

            if (argument === 'block') {
                if (!current) return { output: 'no goal for this session' }
                const reason = parts.slice(2).join(' ') || 'blocked by user'
                try {
                    goalPort.block(current.id, { code: 'user-blocked', message: reason })
                } catch (error) {
                    return { output: errorText(error) }
                }
                return { output: 'goal -> blocked' }
            }

            // 其余情况把整行当成 objective。
            const objective = line.trim().slice('/goal'.length).trim()
            const created = goalPort.set(state.sessionId, objective)
            return {
                output: `goal set: ${created.objective} (max ${created.maxGoalRounds} rounds)`,
            }
        }

        case '/continue': {
            const goalPort = ports.goal
            if (!goalPort) return { output: 'goals are not enabled' }
            const current = goalPort.current(state.sessionId)
            if (!current) return { output: 'no goal for this session; use /goal <objective>' }

            let round: number
            try {
                round = goalPort.continueRound(current.id)
            } catch (error) {
                return { output: errorText(error) }
            }
            return {
                output: `round ${round}/${current.maxGoalRounds} started`,
                run: goalContinuationPrompt(current, round),
            }
        }

        default:
            return undefined
    }
}
