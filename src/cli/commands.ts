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

export interface CommandPorts {
    sessions: CommandSessionsPort
    persistence?: CommandPersistencePort
    permissionPresets?: CommandPresetsPort
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
                output: '/help  /sessions  /resume <id>  /delete <id>  /clear  /permissions  /permission <name>  /exit',
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

        default:
            return undefined
    }
}
