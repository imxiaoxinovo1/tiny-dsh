import { type Context, Service } from '@deepseek-ai/cordis'
import { type Agent, type AgentMeta, AgentRuntime } from '../core/agent.ts'

/**
 * D5：把 `AgentRuntime` 包成 `ctx.agents`。
 *
 * runner 直接委托给 `ctx.agentLoop`，所以 agents 依赖 agentLoop（见 seam 清单）。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Agent 注册表。 */
        agents: AgentsService
    }
}

export class AgentsService extends Service {
    readonly runtime: AgentRuntime

    constructor(ctx: Context) {
        super(ctx, 'agents')
        this.runtime = new AgentRuntime((agent, input, options) =>
            ctx.agentLoop.run({
                sessionId: agent.sessionId,
                model: agent.model,
                input,
                ...options,
            }),
        )
    }

    create(meta: { sessionId: string; model: string; workspace?: string }): Agent {
        return this.runtime.create(meta)
    }

    get(id: string): Agent | undefined {
        return this.runtime.get(id)
    }

    list(): AgentMeta[] {
        return this.runtime.list()
    }

    delete(id: string): boolean {
        return this.runtime.delete(id)
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-agents'

/** Agent 通过 agentLoop 推进。 */
export const inject = ['agentLoop']

/** 挂载 `ctx.agents`。 */
export function apply(ctx: Context): void {
    ctx.plugin(AgentsService)
}
