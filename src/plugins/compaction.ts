import { type Context, Service } from '@deepseek-ai/cordis'
import {
    type CompactionOptions,
    CompactionRuntime,
    type PrunerOptions,
    type Summarizer,
} from '../core/compaction.ts'
import type { ChatMessage } from '../core/message.ts'
import {
    createSemanticSummarizer,
    type SemanticMode,
    type SemanticObservation,
    SUMMARY_SYSTEM,
    type SummaryInput,
    summaryPrompt,
} from '../core/semantic-compaction.ts'
import { createJevJudge, type JevConfig } from '../providers/jev.ts'

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
    semanticMode?: SemanticMode
    jev?: JevConfig
}

async function defaultSummarize(
    ctx: Context,
    model: string | undefined,
    input: SummaryInput,
): Promise<string> {
    const llm = ctx.get('llm')
    if (!llm) throw new Error('compaction requires ctx.llm for the default summarizer')
    const response = await llm.complete({
        model: model ?? 'deepseek/deepseek-v4-flash',
        system: SUMMARY_SYSTEM,
        signal: input.signal,
        messages: [{ role: 'user', content: summaryPrompt(input) }],
    })
    return response.content
}

export class CompactionService extends Service {
    readonly runtime: CompactionRuntime
    readonly semanticMode: SemanticMode
    lastObservation: SemanticObservation | undefined

    constructor(ctx: Context, config: CompactionConfig = {}) {
        super(ctx, 'compaction')
        this.semanticMode = config.semanticMode ?? 'off'

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
                config.summarizer ??
                createSemanticSummarizer({
                    mode: this.semanticMode,
                    judge: createJevJudge(config.jev),
                    summarize: (input) => defaultSummarize(ctx, config.model, input),
                    observe: (observation) => {
                        this.lastObservation = observation
                    },
                }),
            options,
            pruner,
            onError: (error) => ctx.logger.error(error),
        })
    }

    /** 需要发给模型的消息（含剪枝与摘要）。 */
    prepare(sessionId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
        return this.runtime.prepare(sessionId, signal)
    }

    /** 显式压缩一次。 */
    maybeCompact(sessionId: string, signal?: AbortSignal): Promise<boolean> {
        return this.runtime.maybeCompact(sessionId, signal)
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
