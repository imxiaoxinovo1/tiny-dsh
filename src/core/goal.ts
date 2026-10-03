import { randomUUID } from 'node:crypto'

/**
 * E4：同会话的持久完成目标 + Round 上限。纯逻辑，不 import cordis。
 *
 * 两件事分开：
 *   - **phase** 是持久状态（active / paused / blocked / complete），回答「目标怎么了」；
 *   - **Round** 是续行配额（`roundsStarted` / `maxGoalRounds`），回答「还能不能再跑一轮」。
 *
 * 达到 Round 上限后 `nextRound()` 返回 undefined（自动续行到此为止），
 * 显式的 `continueRound()` 也会抛可读错误。
 */

/** 目标的四个阶段。 */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** blocked 的原因：机器可路由的 code + 人类可读的 message。 */
export interface GoalBlockReason {
    /** lower-kebab-case 分类。 */
    code: string
    /** 非空说明。 */
    message: string
}

/** 一个完成目标。 */
export interface Goal {
    id: string
    sessionId: string
    objective: string
    phase: GoalPhase
    /** 只在 phase === 'blocked' 时存在。 */
    blockedReason?: GoalBlockReason
    /** Round 上限。 */
    maxGoalRounds: number
    /** 已经开启的 Round 数。 */
    roundsStarted: number
    createdAt: number
    updatedAt: number
}

/** `goal/change` 事件的数据（完整快照，便于回放）。 */
export interface GoalChangeData {
    kind: 'goal/change'
    version: 1
    operation: 'set' | 'pause' | 'resume' | 'block' | 'complete' | 'continue'
    goal: Goal
}

/** 默认 Round 上限。 */
export const DEFAULT_MAX_GOAL_ROUNDS = 3

/** 目标状态机错误。 */
export class GoalError extends Error {
    name = 'GoalError'
}

export interface GoalRuntimeOptions {
    /** 注入时钟（测试用）。 */
    now?: () => number
}

/** 目标状态机。 */
export class GoalRuntime {
    readonly #goals = new Map<string, Goal>()
    readonly #now: () => number

    constructor(options: GoalRuntimeOptions = {}) {
        this.#now = options.now ?? (() => Date.now())
    }

    /** 建一个 active 目标。 */
    set(
        sessionId: string,
        objective: string,
        options: { maxGoalRounds?: number; id?: string } = {},
    ): Goal {
        if (!sessionId) throw new GoalError('goal sessionId is required')
        if (!objective.trim()) throw new GoalError('goal objective is required')
        const at = this.#now()
        const goal: Goal = {
            id: options.id ?? randomUUID(),
            sessionId,
            objective,
            phase: 'active',
            maxGoalRounds: options.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
            roundsStarted: 0,
            createdAt: at,
            updatedAt: at,
        }
        this.#goals.set(goal.id, goal)
        return goal
    }

    get(id: string): Goal | undefined {
        return this.#goals.get(id)
    }

    require(id: string): Goal {
        const goal = this.#goals.get(id)
        if (!goal) throw new GoalError(`goal "${id}" not found`)
        return goal
    }

    list(): Goal[] {
        return [...this.#goals.values()]
    }

    /** 某个 session 当前的目标（最近创建的一个）。 */
    forSession(sessionId: string): Goal | undefined {
        return [...this.#goals.values()].filter((goal) => goal.sessionId === sessionId).at(-1)
    }

    /** active → paused。 */
    pause(id: string): Goal {
        return this.#transition(id, ['active'], 'paused')
    }

    /** paused / blocked → active。 */
    resume(id: string): Goal {
        return this.#transition(id, ['paused', 'blocked'], 'active')
    }

    /** 任意未完成状态 → complete。 */
    complete(id: string): Goal {
        return this.#transition(id, ['active', 'paused', 'blocked'], 'complete')
    }

    /** 标记为 blocked，并记录原因。 */
    block(id: string, reason: GoalBlockReason): Goal {
        const goal = this.require(id)
        if (goal.phase === 'complete') {
            throw new GoalError('goal is complete; cannot block')
        }
        if (!reason.message.trim()) throw new GoalError('block reason message is required')
        const next: Goal = {
            ...goal,
            phase: 'blocked',
            blockedReason: reason,
            updatedAt: this.#now(),
        }
        this.#goals.set(id, next)
        return next
    }

    /** 还能不能自动续行：active 且没到 Round 上限。 */
    canContinue(id: string): boolean {
        const goal = this.#goals.get(id)
        if (!goal) return false
        return goal.phase === 'active' && goal.roundsStarted < goal.maxGoalRounds
    }

    /**
     * 自动续行路径：可以就开一个新 Round 并返回轮次号，否则 undefined。
     * 达到 Round 上限后这里就是「不再自动续行」的闸门。
     */
    nextRound(id: string): number | undefined {
        if (!this.canContinue(id)) return undefined
        return this.#bumpRound(this.require(id))
    }

    /** 显式续行路径（/continue）：不满足条件时抛可读错误。 */
    continueRound(id: string): number {
        const goal = this.require(id)
        if (goal.phase !== 'active') {
            throw new GoalError(`goal is ${goal.phase}; cannot start a round`)
        }
        if (goal.roundsStarted >= goal.maxGoalRounds) {
            throw new GoalError(
                `goal round limit reached (${goal.roundsStarted}/${goal.maxGoalRounds})`,
            )
        }
        return this.#bumpRound(goal)
    }

    /** 从事件快照恢复一个目标。 */
    restore(goal: Goal): Goal {
        this.#goals.set(goal.id, goal)
        return goal
    }

    #bumpRound(goal: Goal): number {
        const roundsStarted = goal.roundsStarted + 1
        this.#goals.set(goal.id, { ...goal, roundsStarted, updatedAt: this.#now() })
        return roundsStarted
    }

    #transition(id: string, allowed: GoalPhase[], phase: GoalPhase): Goal {
        const goal = this.require(id)
        if (!allowed.includes(goal.phase)) {
            throw new GoalError(`goal is ${goal.phase}; cannot move to ${phase}`)
        }
        const next: Goal = { ...goal, phase, updatedAt: this.#now() }
        // blockedReason 只在 blocked 时存在。
        if (phase !== 'blocked') delete next.blockedReason
        this.#goals.set(id, next)
        return next
    }
}
