import { randomUUID } from 'node:crypto'
import type { ChatMessage } from './message.ts'
import { deriveMessages, type SessionEvent, type SessionStore, type SurfaceOp } from './session.ts'

/**
 * E2：上下文压缩。纯逻辑，不 import cordis。
 *
 * 链路：token 估算 → 大工具结果**先剪枝**并重新计量 → 仍然超阈值就把旧区间
 * 摘要成检查点（compaction/start → summary → user/message(surfaceOp) → end）。
 *
 * 三个不变式：
 *   1. 区间边界不能切开 tool_call / tool_result 配对；
 *   2. 摘要失败只留 `compaction/start`，绝不写 `compaction/end`（不做假完成）；
 *   3. 「改写历史」靠 surfaceOp 遮蔽，事件本身仍然只追加。
 */

/** token 计量端口（由 ctx.tokenMeter 实现）。 */
export interface TokenMeterPort {
    countMessages(messages: readonly ChatMessage[]): number
}

/** 摘要输入：被压缩的区间与它投影出的消息。 */
export interface SummarizeInput {
    sessionId: string
    start: number
    end: number
    messages: ChatMessage[]
    /** Latest user request for semantic prioritization; not an execution instruction. */
    task?: string
    signal?: AbortSignal
}

/** 摘要器；测试与真实运行都可以替换。 */
export type Summarizer = (input: SummarizeInput) => Promise<string>

/** 工具结果剪枝参数。 */
export interface PrunerOptions {
    /** 单条较早的 tool 结果最多保留的字符数。 */
    maxToolResultChars: number
    /** 最近的 N 条消息不剪，保持上下文新鲜。 */
    keepRecentMessages: number
}

/** 压缩阈值与区间选择参数。 */
export interface CompactionOptions {
    /** 估算 token 超过它就尝试压缩。 */
    maxTokens: number
    /** 尾部保留的原始事件数。 */
    keepRecentEvents: number
    /** 可压缩区间少于这么多事件就不做。 */
    minEvents: number
}

export interface CompactionDeps {
    sessions: SessionStore
    tokenMeter: TokenMeterPort
    summarizer: Summarizer
    options?: Partial<CompactionOptions>
    pruner?: Partial<PrunerOptions>
    /** 摘要失败时的回调（默认静默）。 */
    onError?: (error: unknown) => void
}

export const DEFAULT_COMPACTION: CompactionOptions = {
    maxTokens: 8000,
    keepRecentEvents: 6,
    minEvents: 2,
}

export const DEFAULT_PRUNER: PrunerOptions = {
    maxToolResultChars: 2000,
    keepRecentMessages: 4,
}

const TRUNCATION_MARKER = '\n…[truncated by tool-result pruner]\n'

/** 合并默认值，但忽略显式 undefined（否则会覆盖默认值）。 */
function mergeOptions<T extends object>(base: T, override: Partial<T> | undefined): T {
    const result = { ...base }
    if (!override) return result
    for (const key of Object.keys(override) as (keyof T)[]) {
        const value = override[key]
        if (value !== undefined) result[key] = value as T[keyof T]
    }
    return result
}

/** 截断一条过长的文本：保留头尾，中间用标记替代。 */
export function pruneToolResult(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content
    const head = Math.max(1, Math.floor(maxChars * 0.6))
    const tail = Math.max(0, maxChars - head)
    return content.slice(0, head) + TRUNCATION_MARKER + (tail > 0 ? content.slice(-tail) : '')
}

/** 把较早的、过大的 tool 结果截断；最近的消息保持原样。 */
export function pruneMessages(
    messages: readonly ChatMessage[],
    options: PrunerOptions = DEFAULT_PRUNER,
): ChatMessage[] {
    const cutoff = Math.max(0, messages.length - options.keepRecentMessages)
    return messages.map((message, index) => {
        if (index >= cutoff) return message
        if (message.role !== 'tool') return message
        const content = message.content ?? ''
        if (content.length <= options.maxToolResultChars) return message
        return { ...message, content: pruneToolResult(content, options.maxToolResultChars) }
    })
}

function toolCallIds(event: SessionEvent): string[] {
    if (event.type !== 'assistant/tool_calls') return []
    const data = event.data as { toolCalls?: { id?: unknown }[] } | null
    if (!Array.isArray(data?.toolCalls)) return []
    return data.toolCalls
        .map((call) => (typeof call.id === 'string' ? call.id : ''))
        .filter(Boolean)
}

function toolResultId(event: SessionEvent): string | undefined {
    if (event.type !== 'tool/result') return undefined
    const data = event.data as { toolCallId?: unknown } | null
    return typeof data?.toolCallId === 'string' ? data.toolCallId : undefined
}

/** 区间内每个 tool_call 都必须有配对的 tool/result。 */
export function isPairedRange(events: readonly SessionEvent[]): boolean {
    const pending = new Set<string>()
    for (const event of events) {
        for (const id of toolCallIds(event)) pending.add(id)
        const result = toolResultId(event)
        if (result) pending.delete(result)
    }
    return pending.size === 0
}

function surfaceRanges(events: readonly SessionEvent[]): SurfaceOp[] {
    const ranges: SurfaceOp[] = []
    for (const event of events) {
        const data = event.data as { surfaceOp?: Partial<SurfaceOp> } | null
        const op = data?.surfaceOp
        if (op?.op === 'replace' && typeof op.start === 'number' && typeof op.end === 'number') {
            ranges.push({ op: 'replace', start: op.start, end: op.end })
        }
    }
    return ranges
}

/** 被选中的压缩区间。 */
export interface CompactionRange {
    start: number
    end: number
    messages: ChatMessage[]
}

/**
 * 选出一段可以安全摘要的旧区间：
 * 只看最后一次 reset 之后、且尚未被 surfaceOp 遮蔽的事件；保留尾部若干事件；
 * 区间边界必须落在 tool_call / tool_result 配对完整的位置上。
 */
export function pickCompactionRange(
    events: readonly SessionEvent[],
    options: CompactionOptions = DEFAULT_COMPACTION,
): CompactionRange | undefined {
    let startIndex = 0
    for (let i = 0; i < events.length; i++) {
        if (events[i]?.type === 'session/reset') startIndex = i + 1
    }

    const scoped = events.slice(startIndex)
    const hidden = surfaceRanges(scoped)
    const eligible = scoped.filter(
        (event) => !hidden.some((op) => event.seq >= op.start && event.seq <= op.end),
    )

    if (eligible.length <= options.keepRecentEvents + options.minEvents) return undefined

    let included = eligible.slice(0, eligible.length - options.keepRecentEvents)
    // 不能把 tool_call 和它的 tool/result 切到两个区间里。
    while (included.length > 0 && !isPairedRange(included)) included = included.slice(0, -1)

    const first = included[0]
    const last = included[included.length - 1]
    if (included.length < options.minEvents || !first || !last) return undefined
    return { start: first.seq, end: last.seq, messages: deriveMessages(included) }
}

/** 压缩运行时。 */
export class CompactionRuntime {
    readonly #deps: CompactionDeps
    readonly #options: CompactionOptions
    readonly #pruner: PrunerOptions

    constructor(deps: CompactionDeps) {
        this.#deps = deps
        this.#options = mergeOptions(DEFAULT_COMPACTION, deps.options)
        this.#pruner = mergeOptions(DEFAULT_PRUNER, deps.pruner)
    }

    /** 阈值。 */
    get maxTokens(): number {
        return this.#options.maxTokens
    }

    /**
     * 生产发给模型的消息：超阈值时先剪枝并重新计量，仍超标才做摘要，
     * 最后重新投影（并再剪一次尾部的大结果）。
     */
    async prepare(sessionId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
        const sessions = this.#deps.sessions
        const tokenMeter = this.#deps.tokenMeter

        let messages = sessions.deriveMessages(sessionId)
        if (tokenMeter.countMessages(messages) <= this.#options.maxTokens) return messages

        // 工具大结果先走 pruner 截断，再重新计量。
        messages = pruneMessages(messages, this.#pruner)
        if (tokenMeter.countMessages(messages) <= this.#options.maxTokens) return messages

        const compacted = await this.maybeCompact(sessionId, signal)
        if (!compacted) return messages
        return pruneMessages(sessions.deriveMessages(sessionId), this.#pruner)
    }

    /**
     * 把一段旧区间摘要成检查点。
     *
     * @returns 是否真的写入了检查点。
     */
    async maybeCompact(sessionId: string, signal?: AbortSignal): Promise<boolean> {
        signal?.throwIfAborted()
        const { sessions, tokenMeter, summarizer } = this.#deps
        const session = sessions.require(sessionId)
        const range = pickCompactionRange(session.events, this.#options)
        if (!range) return false

        const id = randomUUID()
        const tokensBefore = tokenMeter.countMessages(deriveMessages(session.events))
        sessions.append(sessionId, 'compaction/start', {
            id,
            start: range.start,
            end: range.end,
        })

        let summary: string
        try {
            summary = await summarizer({
                sessionId,
                start: range.start,
                end: range.end,
                messages: range.messages,
                signal,
                task:
                    sessions
                        .deriveMessages(sessionId)
                        .findLast((message) => message.role === 'user')?.content ?? undefined,
            })
            if (!summary.trim()) throw new Error('empty checkpoint summary')
        } catch (error) {
            signal?.throwIfAborted()
            // 只留 start：没有 summary / end，就不会出现「假完成」。
            this.#deps.onError?.(error)
            return false
        }

        signal?.throwIfAborted()
        sessions.append(sessionId, 'compaction/summary', {
            id,
            start: range.start,
            end: range.end,
            content: summary,
        })
        sessions.append(sessionId, 'user/message', {
            content: `## Summary of earlier conversation\n\n${summary}`,
            surfaceOp: { op: 'replace', start: range.start, end: range.end },
        })
        sessions.append(sessionId, 'compaction/end', {
            id,
            tokensBefore,
            tokensAfter: tokenMeter.countMessages(sessions.deriveMessages(sessionId)),
        })
        return true
    }
}
