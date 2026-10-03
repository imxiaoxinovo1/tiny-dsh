import { type Context, Service } from '@deepseek-ai/cordis'
import { AgentLoopRuntime, type RunParams, type RunResult } from '../core/loop.ts'

/**
 * D5：把 `AgentLoopRuntime` 包成 `ctx.agentLoop`。
 *
 * 依赖 sessions / tools / llm；system prompt 是**可选**能力（D6 提供），
 * 用 `ctx.get()` 探测而不是写进 inject —— 卸载 systemPrompt 后核心链路照跑。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** model → tool → model 的推进器。 */
        agentLoop: AgentLoopService
    }
}

/** D6 的 ctx.systemPrompt 形状；这里只要 assemble。 */
interface SystemPromptLike {
    assemble?: () => string | Promise<string>
}

export class AgentLoopService extends Service {
    readonly runtime: AgentLoopRuntime

    constructor(ctx: Context) {
        super(ctx, 'agentLoop')
        this.runtime = new AgentLoopRuntime({
            sessions: ctx.sessions.store,
            tools: ctx.tools.registry,
            llm: ctx.llm.runtime,
            // 每一步重新组装，保证时间 / cwd 新鲜。
            system: async () => {
                const prompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
                return prompt?.assemble ? await prompt.assemble() : ''
            },
        })
    }

    run(params: RunParams): Promise<RunResult> {
        return this.runtime.run(params)
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-agent-loop'

/** 核心链路依赖；systemPrompt 是可选的，不在这里。 */
export const inject = ['sessions', 'tools', 'llm']

/** 挂载 `ctx.agentLoop`。 */
export function apply(ctx: Context): void {
    ctx.plugin(AgentLoopService)
}
