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
    | (string & {})

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

/**
 * 把事件日志折叠成模型能消费的消息序列。
 *
 * 非消息事件（`session/reset`、未来的 `compaction/*`）在这里被消费：
 * `session/reset` 丢弃此前累积的消息，对应「清空会话」，但事件本身仍留在日志里。
 */
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
    const messages: ChatMessage[] = []

    for (const event of events) {
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

    constructor(header: Partial<SessionHeader> = {}) {
        this.id = header.id ?? randomUUID()
        this.createdAt = header.createdAt ?? new Date().toISOString()
        this.title = header.title
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

/** 内存会话注册表。E1 会用 JSONL provider 替换它的持久化侧。 */
export class SessionStore {
    #sessions = new Map<string, Session>()

    /** 新建一个会话；`meta.title` 可选。 */
    create(meta: { title?: string } = {}): Session {
        const session = new Session({ title: meta.title })
        this.#sessions.set(session.id, session)
        return session
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
