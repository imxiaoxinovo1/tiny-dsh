import { type Context, Service } from '@deepseek-ai/cordis'
import {
    type PromptContext,
    type PromptEntryInfo,
    type PromptSection,
    SystemPromptRuntime,
} from '../core/prompt.ts'

/**
 * D6：把 `SystemPromptRuntime` 包成 `ctx.systemPrompt`。
 *
 * 和 tools / llm 一样，`section()` / `context()` 用 `this.ctx.effect()` 绑定到
 * **调用方** fiber：注册片段的插件卸载时，它的片段自动移除。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** system prompt 的 section / context 组装。 */
        systemPrompt: SystemPromptService
    }
}

export class SystemPromptService extends Service {
    readonly runtime = new SystemPromptRuntime()

    constructor(ctx: Context) {
        super(ctx, 'systemPrompt')
    }

    section(definition: PromptSection): () => void {
        return this.ctx.effect(
            () => this.runtime.section(definition),
            `systemPrompt.section(${definition.name})`,
        )
    }

    context(definition: PromptContext): () => void {
        return this.ctx.effect(
            () => this.runtime.context(definition),
            `systemPrompt.context(${definition.name})`,
        )
    }

    list(): PromptEntryInfo[] {
        return this.runtime.list()
    }

    assemble(): Promise<string> {
        return this.runtime.assemble()
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-system-prompt'

/** 挂载 `ctx.systemPrompt`。 */
export function apply(ctx: Context): void {
    ctx.plugin(SystemPromptService)
}
