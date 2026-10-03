import { type Context, Service } from '@deepseek-ai/cordis'
import {
    type CompactionOptions,
    CompactionRuntime,
    type PrunerOptions,
    type SummarizeInput,
    type Summarizer,
} from '../core/compaction.ts'
import type { ChatMessage } from '../core/message.ts'

/**
 * E2：把 `CompactionRuntime` 包成 `ctx.compaction`。
 *
 * tokenMeter 是硬依赖；llm 只在「默认摘要器」被用到时才需要，所以不写进 inject
 * —— 注入自定义 summarizer（测试）时不需要 llm。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 上下文压缩。 */
        compaction: CompactionService
    }
}

/** compaction 配置。 */
export interface CompactionConfig {
    maxTokens?: number
    keepRecentEvents?: number
    minEvents?: number
    maxToolResultChars?: number
    keepRecentMessages?: number
    /** 摘要用模型；缺省 deepseek/deepseek-v4-flash。 */
    model?: string
    /** 注入摘要器（测试用）；缺省用 ctx.llm。 */
    summarizer?: Summarizer
}

const SUMMARIZE_SYSTEM = [
    'You compress an agent conversation into a durable checkpoint.',
    'Keep concrete facts: file paths, commands, decisions, unresolved questions, and the current plan.',
    'Drop pleasantries and repetition. Reply with the summary only.',
].join('\n')

async function defaultSummarize(
    ctx: Context,
    model: string | undefined,
    input: SummarizeInput,
): Promise<string> {
    const llm = ctx.get('llm')
    if (!llm) throw new Error('compaction requires ctx.llm for the default summarizer')
    const transcript = input.messages
        .map((message) => `${message.role}: ${message.content ?? ''}`)
        .join('\n')
    const response = await llm.complete({
        model: model ?? 'deepseek/deepseek-v4-flash',
        system: SUMMARIZE_SYSTEM,
        messages: [
            { role: 'user', content: `Summarize this conversation segment:\n\n${transcript}` },
        ],
    })
    return response.content
}

export class CompactionService extends Service {
    readonly runtime: CompactionRuntime

    constructor(ctx: Context, config: CompactionConfig = {}) {
        super(ctx, 'compaction')

        // 注意：不能直接 spread 带 undefined 的键，否则会覆盖默认值。
        const options: Partial<CompactionOptions> = {}
        if (config.maxTokens !== undefined) options.maxTokens = config.maxTokens
        if (config.keepRecentEvents !== undefined)
            options.keepRecentEvents = config.keepRecentEvents
        if (config.minEvents !== undefined) options.minEvents = config.minEvents

        const pruner: Partial<PrunerOptions> = {}
        if (config.maxToolResultChars !== undefined) {
            pruner.maxToolResultChars = config.maxToolResultChars
        }
        if (config.keepRecentMessages !== undefined) {
            pruner.keepRecentMessages = config.keepRecentMessages
        }

        this.runtime = new CompactionRuntime({
            sessions: ctx.sessions.store,
            tokenMeter: ctx.tokenMeter,
            summarizer:
                config.summarizer ?? ((input) => defaultSummarize(ctx, config.model, input)),
            options,
            pruner,
            onError: (error) => ctx.logger.error(error),
        })
    }

    /** 需要发给模型的消息（含剪枝与摘要）。 */
    prepare(sessionId: string): Promise<ChatMessage[]> {
        return this.runtime.prepare(sessionId)
    }

    /** 显式压缩一次。 */
    maybeCompact(sessionId: string): Promise<boolean> {
        return this.runtime.maybeCompact(sessionId)
    }

    /** 当前阈值。 */
    get maxTokens(): number {
        return this.runtime.maxTokens
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-compaction'

/** 硬依赖 sessions 与 tokenMeter；llm 是可选的。 */
export const inject = ['sessions', 'tokenMeter']

/** 挂载 `ctx.compaction`。 */
export function apply(ctx: Context, config: CompactionConfig = {}): void {
    ctx.plugin(CompactionService, config)
}
