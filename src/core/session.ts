import { randomUUID } from 'node:crypto'
import type { ChatMessage, ToolCall } from './message.ts'

// 这些类型属于「模型消息」而不是「会话」；session 只是它们的生产者与消费者，
// 所以从 message.ts 再导出，调用方仍可只依赖 core/session.ts。
export type { ChatMessage, ChatToolCall, ContentBlock, JsonSchema, ToolCall } from './message.ts'

/**
 * D2：Session 事件日志 + `deriveMessages()` 投影。
 *
 * 这里只放纯逻辑，不 import cordis（见 ARCHITECTURE.md「总体实现设计」第 1 节）：
 *
 *   - Session 存**事件**，不存消息。事件只追加、不改写。
 *   - 发给模型的消息由 `deriveMessages()` 现场投影，不单独维护副本。
 *   - 所以压缩 / 清空这类「改写历史」必须表达成新事件（`session/reset`、
 *     未来的 `compaction/*` + surfaceOp），而不是删事件。
 */

/** 一条会话事件。`seq` 在一个 session 内从 1 单调递增。 */
export interface SessionEvent {
    seq: number
    type: SessionEventType
    data: unknown
    at: string
}

/** 已知事件类型；`(string & {})` 让自定义事件也能通过类型检查。 */
export type SessionEventType =
    | 'session/reset'
    | 'user/message'
    | 'assistant/message'
    | 'assistant/tool_calls'
    | 'tool/result'
    | 'compaction/start'
    | 'compaction/summary'
    | 'compaction/end'
    | 'goal/change'
    | (string & {})

/**
 * surface 遮蔽：投影时把 `[start, end]`（按 seq，闭区间）的事件替换成当前这条消息。
 *
 * 事件只追加、不改写 —— 压缩不是删历史，而是让新消息在投影里遮住旧区间。
 */
export interface SurfaceOp {
    op: 'replace'
    start: number
    end: number
}

/** `compaction/start` 事件的数据。 */
export interface CompactionStartData {
    id: string
    start: number
    end: number
}

/** `compaction/summary` 事件的数据。 */
export interface CompactionSummaryData extends CompactionStartData {
    content: string
}

/** `compaction/end` 事件的数据；token 统计在这里收口。 */
export interface CompactionEndData {
    id: string
    tokensBefore?: number
    tokensAfter?: number
}

/** 会话元数据：可列表化，不含事件体。 */
export interface SessionMeta {
    id: string
    createdAt: string
    title?: string
    eventCount: number
}

/** 一个会话：header（id / createdAt / title）+ 追加式事件日志。 */
export interface SessionHeader {
    id: string
    createdAt: string
    title?: string
}

/** `user/message` 事件的数据。 */
export interface UserMessageData {
    content: string
    /** 带 surfaceOp 时，这条消息在投影里替换旧区间（压缩检查点）。 */
    surfaceOp?: SurfaceOp
}

/** `assistant/message` 事件的数据。 */
export interface AssistantMessageData {
    content: string
    reasoningContent?: string
}

/** `assistant/tool_calls` 事件的数据；`arguments` 是已解析的值。 */
export interface AssistantToolCallsData {
    content?: string
    reasoningContent?: string
    toolCalls: ToolCall[]
}

/** `tool/result` 事件的数据。 */
export interface ToolResultData {
    toolCallId: string
    content: string
    isError?: boolean
}

/**
 * 把 tool_call 的 arguments 规范成 Chat Completions 要求的 JSON 字符串。
 *
 * 事件里存的是**已解析**的值（loop 要拿它去执行），投影时要重新序列化；
 * 已经是对 wire 字符串的输入原样透传，避免二次编码。
 */
export function serializeToolArguments(value: unknown): string {
    if (typeof value === 'string') return value
    return JSON.stringify(value ?? {})
}

/** 从事件 data 里读出一个合法的 surfaceOp。 */
function readSurfaceOp(data: unknown): SurfaceOp | undefined {
    if (typeof data !== 'object' || data === null) return undefined
    const op = (data as { surfaceOp?: unknown }).surfaceOp
    if (typeof op !== 'object' || op === null) return undefined
    const candidate = op as Partial<SurfaceOp>
    if (candidate.op !== 'replace') return undefined
    if (typeof candidate.start !== 'number' || typeof candidate.end !== 'number') {
        return undefined
    }
    return { op: 'replace', start: candidate.start, end: candidate.end }
}

/** 一条 surfaceOp 替换：在区间起点插入 message，并隐藏整个区间。 */
interface SurfaceReplacement {
    range: SurfaceOp
    message: ChatMessage
    /** 产生这条替换的事件 seq（折叠到它时不再重复投影）。 */
    sourceSeq: number
}

/**
 * 把事件日志折叠成模型能消费的消息序列。
 *
 * 非消息事件（`session/reset`、未来的 `compaction/*`）在这里被消费：
 * `session/reset` 丢弃此前累积的消息，对应「清空会话」，但事件本身仍留在日志里。
 */
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
    // 最后一次 reset 之前的事件在投影里已经不存在。
    let start = 0
    for (let i = 0; i < events.length; i++) {
        if (events[i]?.type === 'session/reset') start = i + 1
    }

    // 第一遍收集 surfaceOp 替换：区间指向**过去**的 seq，而且替换消息要在
    // 区间起点插入（不能等它追加到日志末尾），所以必须先扫一遍。
    const replacements: SurfaceReplacement[] = []
    for (let i = start; i < events.length; i++) {
        const event = events[i]
        if (!event) continue
        const op = readSurfaceOp(event.data)
        if (!op) continue
        const data = (event.data ?? {}) as Partial<UserMessageData>
        replacements.push({
            range: op,
            message: { role: 'user', content: data.content ?? '' },
            sourceSeq: event.seq,
        })
    }
    const isHidden = (seq: number) =>
        replacements.some(
            (replacement) => seq >= replacement.range.start && seq <= replacement.range.end,
        )
    const emitted = new Set<number>()
    const consumed = new Set<number>(replacements.map((replacement) => replacement.sourceSeq))

    const messages: ChatMessage[] = []
    for (let i = start; i < events.length; i++) {
        const event = events[i]
        if (!event) continue
        // 到达区间起点时插入替换消息（只插一次）。
        for (const replacement of replacements) {
            if (replacement.range.start === event.seq && !emitted.has(event.seq)) {
                emitted.add(event.seq)
                messages.push(replacement.message)
            }
        }
        if (consumed.has(event.seq) || isHidden(event.seq)) continue
        switch (event.type) {
            case 'session/reset': {
                messages.length = 0
                break
            }
            case 'user/message': {
                const data = (event.data ?? {}) as Partial<UserMessageData>
                messages.push({ role: 'user', content: data.content ?? '' })
                break
            }
            case 'assistant/message': {
                const data = (event.data ?? {}) as Partial<AssistantMessageData>
                const message: ChatMessage = { role: 'assistant', content: data.content ?? '' }
                if (data.reasoningContent) message.reasoning_content = data.reasoningContent
                messages.push(message)
                break
            }
            case 'assistant/tool_calls': {
                const data = (event.data ?? {}) as Partial<AssistantToolCallsData>
                const message: ChatMessage = {
                    role: 'assistant',
                    content: data.content ?? null,
                    tool_calls: (data.toolCalls ?? []).map((call) => ({
                        id: call.id,
                        type: 'function',
                        function: {
                            name: call.name,
                            arguments: serializeToolArguments(call.arguments),
                        },
                    })),
                }
                // ROADMAP D2 验收：reasoning_content 随 assistant/tool_calls 一起保留。
                if (data.reasoningContent) message.reasoning_content = data.reasoningContent
                messages.push(message)
                break
            }
            case 'tool/result': {
                const data = (event.data ?? {}) as Partial<ToolResultData>
                messages.push({
                    role: 'tool',
                    tool_call_id: data.toolCallId ?? '',
                    content: data.content ?? '',
                })
                break
            }
            default:
                // 未知事件不进投影，保证追加新事件类型不会破坏旧调用方。
                break
        }
    }

    return messages
}

/**
 * 一个会话实例：header 不可变，事件只追加。
 *
 * `clear()` 追加一条 `session/reset` 而不是清空数组，遵守「事件只追加」不变式；
 * 投影从最后一条 reset 之后重新累积。
 */
export class Session {
    readonly id: string
    readonly createdAt: string
    title?: string

    #events: SessionEvent[] = []
    #seq = 0
    #listener: ((event: SessionEvent) => void) | undefined

    constructor(header: Partial<SessionHeader> = {}, events: readonly SessionEvent[] = []) {
        this.id = header.id ?? randomUUID()
        this.createdAt = header.createdAt ?? new Date().toISOString()
        this.title = header.title
        // 从磁盘恢复时直接灌入历史事件，seq 从最大值继续。
        for (const event of events) {
            this.#events.push(event)
            if (event.seq > this.#seq) this.#seq = event.seq
        }
    }

    /** 绑定「事件已追加」监听；由 SessionStore 用于通知持久化观察者。 */
    bind(listener: (event: SessionEvent) => void): void {
        this.#listener = listener
    }

    /** 事件日志（只读视图）。 */
    get events(): readonly SessionEvent[] {
        return this.#events
    }

    /** 追加一条事件，自动分配 `seq` 与 `at`。 */
    append(type: SessionEventType, data: unknown): SessionEvent {
        const event: SessionEvent = {
            seq: ++this.#seq,
            type,
            data,
            at: new Date().toISOString(),
        }
        this.#events.push(event)
        this.#listener?.(event)
        return event
    }

    /** 清空会话：id / createdAt 不变，投影为空。 */
    clear(): void {
        this.append('session/reset', {})
    }

    /** 现场投影出模型能消费的消息序列。 */
    deriveMessages(): ChatMessage[] {
        return deriveMessages(this.#events)
    }

    /** 列表用的元数据快照；title 缺省时不出现该字段，方便 JSON 往返。 */
    meta(): SessionMeta {
        const meta: SessionMeta = {
            id: this.id,
            createdAt: this.createdAt,
            eventCount: this.#events.length,
        }
        if (this.title) meta.title = this.title
        return meta
    }
}

/** 会话生命周期观察者；E1 的持久化 provider 用它把事件落盘。 */
export interface SessionObserver {
    /** 会话被创建（写 header）。 */
    create?(session: Session): void
    /** 任意事件被追加（落一行）。 */
    append?(session: Session, event: SessionEvent): void
}

/** 内存会话注册表；持久化由观察者挂载，store 自身不碰磁盘。 */
export class SessionStore {
    #sessions = new Map<string, Session>()
    #observers = new Set<SessionObserver>()

    /** 注册观察者；返回 disposer。 */
    observe(observer: SessionObserver): () => void {
        this.#observers.add(observer)
        return () => {
            this.#observers.delete(observer)
        }
    }

    /** 新建一个会话；`meta.title` 可选。 */
    create(meta: { title?: string } = {}): Session {
        const session = new Session({ title: meta.title })
        this.#attach(session)
        for (const observer of this.#observers) observer.create?.(session)
        return session
    }

    /** 把恢复出来的会话放回 store（不触发 create，避免重写 header）。 */
    adopt(session: Session): Session {
        this.#attach(session)
        return session
    }

    /** 全部会话对象（持久化回填用）。 */
    all(): Session[] {
        return [...this.#sessions.values()]
    }

    #attach(session: Session): void {
        session.bind((event) => {
            for (const observer of this.#observers) observer.append?.(session, event)
        })
        this.#sessions.set(session.id, session)
    }

    /** 取会话，不存在时返回 `undefined`。 */
    get(id: string): Session | undefined {
        return this.#sessions.get(id)
    }

    /** 取会话，不存在时抛可读错误。 */
    require(id: string): Session {
        const session = this.#sessions.get(id)
        if (!session) throw new Error(`session "${id}" not found`)
        return session
    }

    /** 按创建顺序列出全部会话的元数据。 */
    list(): SessionMeta[] {
        return [...this.#sessions.values()].map((session) => session.meta())
    }

    /** 删除会话，返回是否删掉了东西。 */
    delete(id: string): boolean {
        return this.#sessions.delete(id)
    }

    /** 追加事件到指定会话。 */
    append(id: string, type: SessionEventType, data: unknown): SessionEvent {
        return this.require(id).append(type, data)
    }

    /** 清空指定会话。 */
    clear(id: string): void {
        this.require(id).clear()
    }

    /** 投影指定会话。 */
    deriveMessages(id: string): ChatMessage[] {
        return this.require(id).deriveMessages()
    }
}
