import { type Context, Service } from '@deepseek-ai/cordis'
import {
    DEFAULT_MAX_GOAL_ROUNDS,
    type Goal,
    type GoalBlockReason,
    type GoalChangeData,
    GoalRuntime,
} from '../core/goal.ts'
import type { SessionStore } from '../core/session.ts'

/**
 * E4：把 `GoalRuntime` 包成 `ctx.goal`，并把每次变更落成一条 `goal/change` 事件。
 *
 * 目标是**持久**的：事件写进会话日志（E1 会把它落盘），`restore()` 从事件里
 * 折出最后一个完整快照，进程重启后 `/resume` 能恢复。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 持久完成目标。 */
        goal: GoalService
    }
}

/** goal 配置。 */
export interface GoalConfig {
    /** 默认 Round 上限。 */
    maxGoalRounds?: number
}

export class GoalService extends Service {
    readonly runtime = new GoalRuntime()
    // 不用 # 私有字段：Service 方法里的 this 是 tracing 影子代理。
    private sessionStore: SessionStore
    private defaultMaxRounds: number

    constructor(ctx: Context, config: GoalConfig = {}) {
        super(ctx, 'goal')
        this.sessionStore = ctx.sessions.store
        this.defaultMaxRounds = config.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS
    }

    /** 建一个 active 目标并落事件。 */
    set(sessionId: string, objective: string, options: { maxGoalRounds?: number } = {}): Goal {
        const goal = this.runtime.set(sessionId, objective, {
            maxGoalRounds: options.maxGoalRounds ?? this.defaultMaxRounds,
        })
        this.record('set', goal)
        return goal
    }

    get(id: string): Goal | undefined {
        return this.runtime.get(id)
    }

    /** 某个 session 当前的目标。 */
    current(sessionId: string): Goal | undefined {
        return this.runtime.forSession(sessionId)
    }

    list(): Goal[] {
        return this.runtime.list()
    }

    pause(id: string): Goal {
        const goal = this.runtime.pause(id)
        this.record('pause', goal)
        return goal
    }

    resume(id: string): Goal {
        const goal = this.runtime.resume(id)
        this.record('resume', goal)
        return goal
    }

    complete(id: string): Goal {
        const goal = this.runtime.complete(id)
        this.record('complete', goal)
        return goal
    }

    block(id: string, reason: GoalBlockReason): Goal {
        const goal = this.runtime.block(id, reason)
        this.record('block', goal)
        return goal
    }

    /** 还能不能自动续行。 */
    canContinue(id: string): boolean {
        return this.runtime.canContinue(id)
    }

    /** 自动续行：上限内返回新轮次号，否则 undefined（不再自动续行）。 */
    nextRound(id: string): number | undefined {
        const round = this.runtime.nextRound(id)
        if (round !== undefined) this.record('continue', this.runtime.require(id))
        return round
    }

    /** 显式续行（/continue）：不满足条件时抛错。 */
    continueRound(id: string): number {
        const round = this.runtime.continueRound(id)
        this.record('continue', this.runtime.require(id))
        return round
    }

    /**
     * 从会话事件里恢复目标（最后一个 `goal/change` 快照）。
     *
     * @returns 恢复出的目标；没有目标事件时返回 undefined。
     */
    restore(sessionId: string): Goal | undefined {
        const session = this.sessionStore.get(sessionId)
        if (!session) return undefined
        let snapshot: Goal | undefined
        for (const event of session.events) {
            if (event.type !== 'goal/change') continue
            const data = event.data as Partial<GoalChangeData> | null
            if (data?.goal) snapshot = data.goal
        }
        return snapshot ? this.runtime.restore(snapshot) : undefined
    }

    private record(operation: GoalChangeData['operation'], goal: Goal): void {
        const data: GoalChangeData = { kind: 'goal/change', version: 1, operation, goal }
        this.sessionStore.append(goal.sessionId, 'goal/change', data)
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-goal'

/** 目标写进会话日志，所以依赖 sessions。 */
export const inject = ['sessions']

/** 挂载 `ctx.goal`。 */
export function apply(ctx: Context, config: GoalConfig = {}): void {
    ctx.plugin(GoalService, config)
}
