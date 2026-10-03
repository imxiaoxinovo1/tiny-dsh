import type { ContentBlock, JsonSchema, ToolCall } from './message.ts'

/**
 * D3：工具注册表 + OpenAI function schema + 统一执行结果。
 *
 * 纯逻辑，不 import cordis。插件层（`plugins/tools.ts`）负责把它挂成
 * `ctx.tools`，并把 `register()` 的 disposer 绑定到 fiber 生命周期。
 *
 * 执行流水线的不变式：**无论成败都返回一条 `ToolResult`**，这样 loop 永远能
 * 为每个 tool_call 写出一条配对的 `tool/result`；只有取消（AbortError）穿透。
 */

/** 调用方提供的执行上下文；D7 会补上 approval / sandbox。 */
export interface ToolExecutionContext {
    sessionId?: string
    cwd?: string
    signal?: AbortSignal
}

/** 规范化后交给工具实现的上下文：signal 一定有值。 */
export interface ToolExecution extends ToolExecutionContext {
    toolCallId: string
    signal: AbortSignal
}

/** 一个已注册的工具。 */
export interface ToolDefinition {
    name: string
    description: string
    parameters: JsonSchema
    /** 执行本体；接收已解析的 arguments，必须自己转发 `exec.signal`。 */
    execute(args: unknown, exec: ToolExecution): Promise<unknown>
    /** 可选的输出投影；缺省时把返回值 JSON 序列化成文本。 */
    render?(args: unknown, value: unknown): ContentBlock[]
}

/** 发给模型的 OpenAI function schema；**绝不**包含 execute / render。 */
export interface ToolSchema {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: JsonSchema
    }
}

/** 统一执行结果，可直接写进会话的 `tool/result` 事件。 */
export interface ToolResult {
    toolCallId: string
    name: string
    content: string
    isError: boolean
    /** 成功时的原始返回值；失败或未知工具时为空。 */
    value?: unknown
}

/** 把任意返回值渲染成模型可读文本。 */
export function toText(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === undefined) return ''
    const json = JSON.stringify(value, null, 2)
    return json ?? String(value)
}

/** 把工具返回的内容块拼成文本（D3 只有 text 块）。 */
export function blocksToText(blocks: readonly ContentBlock[]): string {
    return blocks
        .map((block) => block.text)
        .filter(Boolean)
        .join('\n')
}

/** 取消是控制流而不是工具错误：只有它穿透执行流水线。 */
export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

/** 构造一个 AbortError。 */
export function abortError(message = 'Aborted'): Error {
    const error = new Error(message)
    error.name = 'AbortError'
    return error
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** 内存工具注册表。 */
export class ToolRegistry {
    #tools = new Map<string, ToolDefinition>()

    /** 注册一个工具；返回幂等的 disposer。 */
    register(definition: ToolDefinition): () => void {
        if (!definition?.name) throw new Error('tool.name is required')
        if (typeof definition.execute !== 'function') {
            throw new Error(`tool "${definition.name}" is missing execute()`)
        }
        if (this.#tools.has(definition.name)) {
            throw new Error(`duplicate tool name: ${definition.name}`)
        }

        this.#tools.set(definition.name, definition)
        let disposed = false

        return () => {
            if (disposed) return
            disposed = true
            // 只删自己注册的那一份，避免误伤同名重注册后的新定义。
            if (this.#tools.get(definition.name) === definition) {
                this.#tools.delete(definition.name)
            }
        }
    }

    get(name: string): ToolDefinition | undefined {
        return this.#tools.get(name)
    }

    has(name: string): boolean {
        return this.#tools.has(name)
    }

    list(): ToolDefinition[] {
        return [...this.#tools.values()]
    }

    /** 构造模型侧的 schema 列表（白名单字段，不泄漏实现）。 */
    schemas(): ToolSchema[] {
        return this.list().map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description ?? '',
                parameters: tool.parameters ?? { type: 'object', properties: {} },
            },
        }))
    }

    /** 执行一次 tool_call，永远返回统一的 `ToolResult`。 */
    async execute(call: ToolCall, context: ToolExecutionContext = {}): Promise<ToolResult> {
        const signal = context.signal ?? new AbortController().signal
        // 已经取消就不再进入工具本体。
        if (signal.aborted) throw abortError()

        const exec: ToolExecution = {
            toolCallId: call.id,
            sessionId: context.sessionId,
            cwd: context.cwd,
            signal,
        }

        const tool = this.#tools.get(call.name)
        if (!tool) {
            return {
                toolCallId: call.id,
                name: call.name,
                content: `Unknown tool: ${call.name}`,
                isError: true,
            }
        }

        try {
            const value = await tool.execute(call.arguments, exec)
            const content = tool.render
                ? blocksToText(tool.render(call.arguments, value))
                : toText(value)
            return { toolCallId: call.id, name: call.name, content, isError: false, value }
        } catch (error) {
            // 取消不收敛：loop 需要在补完事件日志后把它抛给调用方。
            if (isAbortError(error)) throw error
            return {
                toolCallId: call.id,
                name: call.name,
                content: `ToolError: ${errorText(error)}`,
                isError: true,
            }
        }
    }
}
