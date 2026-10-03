import type { ChatMessage, ToolCall } from './message.ts'
import type { ToolSchema } from './tool.ts'

/**
 * D4：LLM 适配层。纯逻辑，不 import cordis，也不碰网络。
 *
 * 分三块，各自可单测：
 *   1. `SseParser`                 增量 SSE 解析（含「末行无换行」与 `[DONE]`）
 *   2. `ModelAssembler`           把流式分片拼成一次 `ModelResponse`
 *   3. `LlmRuntime`               Provider 注册 / 路由；`complete()` 串起前两者
 *
 * 网络与协议细节在 `providers/deepseek.ts`：它把 HTTP body 变成 `ModelChunk`。
 */

/** 一次模型请求；messages 由 `deriveMessages()` 投影得到。 */
export interface ModelRequest {
    /** `provider/model`，或裸 model（走默认 provider）。 */
    model: string
    /** 每步重新组装的 system prompt。 */
    system?: string
    messages: ChatMessage[]
    tools?: ToolSchema[]
    signal?: AbortSignal
    /** 推理内容增量回调（DeepSeek reasoner）。 */
    onReasoning?: (chunk: string) => void
    /** 正文增量回调。 */
    onContent?: (chunk: string) => void
}

/** 一次模型响应：正文 + 推理内容 + 已解析的 tool_calls。 */
export interface ModelResponse {
    content: string
    reasoningContent?: string
    toolCalls: ToolCall[]
}

/**
 * Provider 吐出的规范化流式分片。
 *
 * `tool_call.arguments` 是**原始字符串分片**，拼装与 parse 由 `ModelAssembler` 负责。
 */
export type ModelChunk =
    | { type: 'content'; text: string }
    | { type: 'reasoning'; text: string }
    | {
          type: 'tool_call'
          index: number
          id?: string
          name?: string
          arguments?: string
      }

/** LLM Provider：把一次请求变成一串 `ModelChunk`。 */
export interface LlmProvider {
    name: string
    stream(request: ModelRequest): AsyncIterable<ModelChunk>
}

/** Provider 注册选项。 */
export interface RegisterOptions {
    /** 设为 true 时作为裸 model 的默认 provider；首个注册的 provider 自动成为默认。 */
    default?: boolean
}

/**
 * 增量 SSE 解析器。
 *
 * - 只消费 `data:` 行；注释行（`:`）与其它字段忽略，`\r\n` 也接受。
 * - 每条 `data:` 行产出一个载荷（OpenAI / DeepSeek 一个事件一行 data）。
 * - `data: [DONE]` 只把 `done` 置真，不产出载荷。
 * - `end()` 冲出缓冲区里最后一条**没有换行结尾**的记录。
 */
export class SseParser {
    #buffer = ''
    #done = false

    /** 是否已经收到 `[DONE]`。 */
    get done(): boolean {
        return this.#done
    }

    /** 喂一段文本，返回本次能完整解析出的载荷。 */
    push(chunk: string): string[] {
        this.#buffer += chunk
        const payloads: string[] = []
        let index = this.#buffer.indexOf('\n')
        while (index >= 0) {
            const line = this.#buffer.slice(0, index).replace(/\r$/, '')
            this.#buffer = this.#buffer.slice(index + 1)
            this.#handleLine(line, payloads)
            index = this.#buffer.indexOf('\n')
        }
        return payloads
    }

    /** 流结束：处理缓冲区里没有换行结尾的最后一条记录。 */
    end(): string[] {
        const payloads: string[] = []
        if (this.#buffer.length > 0) {
            const line = this.#buffer.replace(/\r$/, '')
            this.#buffer = ''
            this.#handleLine(line, payloads)
        }
        return payloads
    }

    #handleLine(line: string, payloads: string[]): void {
        if (!line || line.startsWith(':')) return
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        if (field !== 'data') return
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (value === '[DONE]') {
            this.#done = true
            return
        }
        payloads.push(value)
    }
}

/**
 * 流结束后才解析 tool_call 的 arguments。
 *
 * 空字符串归一为 `{}`；不是合法 JSON 时保留原文，让工具本体给出可读错误。
 */
export function parseToolArguments(raw: string): unknown {
    const text = raw.trim()
    if (!text) return {}
    try {
        return JSON.parse(text)
    } catch {
        return raw
    }
}

/**
 * 把流式分片拼装成一次 `ModelResponse`。
 *
 * 两个关键点：
 * - `name` **只赋值不追加**：同一个 tool_call 的后续分片重复带 name 时，
 *   追加会得到 `read_fileread_file` 这类坏名字。
 * - `arguments` 是分片字符串，**必须等流结束再 parse**。
 */
export class ModelAssembler {
    #content = ''
    #reasoning = ''
    #calls = new Map<number, { id: string; name: string; arguments: string }>()

    push(chunk: ModelChunk): void {
        switch (chunk.type) {
            case 'content':
                this.#content += chunk.text
                break
            case 'reasoning':
                this.#reasoning += chunk.text
                break
            case 'tool_call': {
                const call = this.#calls.get(chunk.index) ?? { id: '', name: '', arguments: '' }
                if (chunk.id) call.id = chunk.id
                if (chunk.name) call.name = chunk.name
                if (chunk.arguments) call.arguments += chunk.arguments
                this.#calls.set(chunk.index, call)
                break
            }
        }
    }

    /** 收尾：解析每个 tool_call 的 arguments，按 index 排序。 */
    finish(): ModelResponse {
        const response: ModelResponse = { content: this.#content, toolCalls: [] }
        if (this.#reasoning) response.reasoningContent = this.#reasoning
        response.toolCalls = [...this.#calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([index, call]) => ({
                id: call.id || `call_${index}`,
                name: call.name,
                arguments: parseToolArguments(call.arguments),
            }))
        return response
    }
}

/** 消费 provider 的流，边触发回调边拼装。 */
export async function assembleModelStream(
    chunks: AsyncIterable<ModelChunk>,
    hooks: Pick<ModelRequest, 'onContent' | 'onReasoning'> = {},
): Promise<ModelResponse> {
    const assembler = new ModelAssembler()
    for await (const chunk of chunks) {
        assembler.push(chunk)
        if (chunk.type === 'content') hooks.onContent?.(chunk.text)
        else if (chunk.type === 'reasoning') hooks.onReasoning?.(chunk.text)
    }
    return assembler.finish()
}

/** OpenAI / DeepSeek `chat.completion.chunk` 里我们需要的最小子集。 */
interface ChatCompletionDelta {
    content?: string | null
    reasoning_content?: string | null
    tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
    }> | null
}

/** 一条 SSE 载荷的形状；解析失败或没有 delta 时返回空数组。 */
export function parseChatCompletionChunk(payload: string): ModelChunk[] {
    let parsed: { choices?: Array<{ delta?: ChatCompletionDelta | null }> | null }
    try {
        parsed = JSON.parse(payload) as typeof parsed
    } catch {
        return []
    }

    const delta = parsed.choices?.[0]?.delta
    if (!delta) return []

    const chunks: ModelChunk[] = []
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        chunks.push({ type: 'reasoning', text: delta.reasoning_content })
    }
    if (typeof delta.content === 'string' && delta.content) {
        chunks.push({ type: 'content', text: delta.content })
    }
    for (const call of delta.tool_calls ?? []) {
        chunks.push({
            type: 'tool_call',
            index: call.index ?? 0,
            ...(call.id ? { id: call.id } : {}),
            ...(call.function?.name ? { name: call.function.name } : {}),
            ...(call.function?.arguments ? { arguments: call.function.arguments } : {}),
        })
    }
    return chunks
}

/** Provider 注册表 + 路由。 */
export class LlmRuntime {
    #providers = new Map<string, LlmProvider>()
    #default: string | undefined

    /** 注册 provider；返回幂等 disposer。首个注册的自动成为默认。 */
    register(provider: LlmProvider, options: RegisterOptions = {}): () => void {
        if (!provider?.name) throw new Error('provider.name is required')
        if (typeof provider.stream !== 'function') {
            throw new Error(`provider "${provider.name}" is missing stream()`)
        }
        if (this.#providers.has(provider.name)) {
            throw new Error(`duplicate provider name: ${provider.name}`)
        }

        this.#providers.set(provider.name, provider)
        if (options.default || this.#providers.size === 1) this.#default = provider.name

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true
            if (this.#providers.get(provider.name) !== provider) return
            this.#providers.delete(provider.name)
            if (this.#default === provider.name) {
                this.#default = this.#providers.keys().next().value
            }
        }
    }

    get(name: string): LlmProvider | undefined {
        return this.#providers.get(name)
    }

    has(name: string): boolean {
        return this.#providers.has(name)
    }

    list(): LlmProvider[] {
        return [...this.#providers.values()]
    }

    /** 默认 provider 名；没有注册时为 undefined。 */
    get defaultProvider(): string | undefined {
        return this.#default
    }

    /** 把 `provider/model` 拆成 provider 与上游 model；没有前缀时走默认 provider。 */
    resolve(model: string): { provider: LlmProvider; model: string } {
        const slash = model.indexOf('/')
        if (slash > 0) {
            const provider = this.#providers.get(model.slice(0, slash))
            if (provider) return { provider, model: model.slice(slash + 1) }
        }
        if (this.#default) {
            const provider = this.#providers.get(this.#default)
            if (provider) return { provider, model }
        }
        throw new Error(`no LLM provider registered for model "${model}"`)
    }

    /** 路由并完成一次请求；路由失败也返回 rejected promise，不同步抛。 */
    async complete(request: ModelRequest): Promise<ModelResponse> {
        const { provider, model } = this.resolve(request.model)
        return assembleModelStream(provider.stream({ ...request, model }), request)
    }
}
