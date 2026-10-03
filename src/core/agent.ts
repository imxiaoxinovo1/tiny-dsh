import { randomUUID } from 'node:crypto'
import type { RunOptions, RunResult } from './loop.ts'

/**
 * D5：Agent 句柄与注册表。纯逻辑，不 import cordis。
 *
 * Agent 只做三件事：绑定 session + model、持有取消入口、把 run 交给 runner
 * （真正的推进逻辑在 `core/loop.ts`，由 `plugins/agent-loop.ts` 注入）。
 */

/** Agent 列表用的元数据。 */
export interface AgentMeta {
    id: string
    sessionId: string
    model: string
    workspace?: string
    createdAt: string
}

/** 驱动一次 run 的函数；由 agent-loop 插件注入。 */
export type AgentRunner = (agent: Agent, input: string, options: RunOptions) => Promise<RunResult>

/** 一个 Agent。 */
export class Agent {
    readonly id: string
    readonly sessionId: string
    readonly createdAt: string
    model: string
    workspace?: string

    readonly #runner: AgentRunner
    #controller: AbortController | undefined

    constructor(meta: AgentMeta, runner: AgentRunner) {
        this.id = meta.id
        this.sessionId = meta.sessionId
        this.createdAt = meta.createdAt
        this.model = meta.model
        this.workspace = meta.workspace
        this.#runner = runner
    }

    /** 发起一次 run；同一个 Agent 同时只允许一个 run。 */
    run(input: string, options: RunOptions = {}): Promise<RunResult> {
        if (this.#controller) throw new Error(`agent "${this.id}" is already running`)

        const controller = new AbortController()
        this.#controller = controller
        const signal = options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal

        return this.#runner(this, input, { ...options, signal }).finally(() => {
            this.#controller = undefined
        })
    }

    /** 请求取消当前 run；没有在跑时是空操作。 */
    cancel(): void {
        this.#controller?.abort()
    }

    /** 是否有 run 正在执行。 */
    get running(): boolean {
        return this.#controller !== undefined
    }

    /** 列表用的元数据快照。 */
    meta(): AgentMeta {
        const meta: AgentMeta = {
            id: this.id,
            sessionId: this.sessionId,
            model: this.model,
            createdAt: this.createdAt,
        }
        if (this.workspace) meta.workspace = this.workspace
        return meta
    }
}

/** 内存 Agent 注册表。 */
export class AgentRuntime {
    readonly #agents = new Map<string, Agent>()
    readonly #runner: AgentRunner

    constructor(runner: AgentRunner) {
        this.#runner = runner
    }

    create(meta: { sessionId: string; model: string; workspace?: string }): Agent {
        const agent = new Agent(
            {
                id: randomUUID(),
                sessionId: meta.sessionId,
                model: meta.model,
                workspace: meta.workspace,
                createdAt: new Date().toISOString(),
            },
            this.#runner,
        )
        this.#agents.set(agent.id, agent)
        return agent
    }

    get(id: string): Agent | undefined {
        return this.#agents.get(id)
    }

    list(): AgentMeta[] {
        return [...this.#agents.values()].map((agent) => agent.meta())
    }

    delete(id: string): boolean {
        return this.#agents.delete(id)
    }
}
