import type { Context } from '@deepseek-ai/cordis'
import {
    type LlmProvider,
    type ModelChunk,
    type ModelRequest,
    parseChatCompletionChunk,
    SseParser,
} from '../core/llm.ts'

/**
 * D4：DeepSeek Chat Completions 流式 provider。
 *
 * 只做协议与网络：把 SSE body 变成规范化 `ModelChunk`，拼装交给 core。
 * `fetch` 可注入，测试不必真的联网。
 */

/** provider 配置；apiKey 缺省时调用会抛可读错误。 */
export interface DeepSeekConfig {
    apiKey?: string
    baseUrl?: string
    /** 测试注入点；缺省用全局 fetch。 */
    fetch?: typeof globalThis.fetch
}

/** 构造一个 DeepSeek provider（纯工厂，方便单测）。 */
export function createDeepSeekProvider(config: DeepSeekConfig = {}): LlmProvider {
    const baseUrl = (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    const doFetch = config.fetch ?? globalThis.fetch

    return {
        name: 'deepseek',
        async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
            if (!config.apiKey) throw new Error('deepseek: DEEPSEEK_API_KEY is not set')

            const messages = request.system
                ? [{ role: 'system', content: request.system }, ...request.messages]
                : request.messages

            const response = await doFetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({
                    model: request.model,
                    stream: true,
                    messages,
                    ...(request.tools?.length ? { tools: request.tools } : {}),
                }),
                signal: request.signal,
            })

            if (!response.ok) {
                const detail = await response.text().catch(() => '')
                throw new Error(`deepseek: HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
            }
            if (!response.body) throw new Error('deepseek: response has no body')

            const parser = new SseParser()
            const decoder = new TextDecoder()
            const body = response.body as unknown as AsyncIterable<Uint8Array>

            for await (const chunk of body) {
                for (const payload of parser.push(decoder.decode(chunk, { stream: true }))) {
                    yield* parseChatCompletionChunk(payload)
                }
                if (parser.done) return
            }

            // 最后一条可能没有换行结尾。
            for (const payload of parser.end()) {
                yield* parseChatCompletionChunk(payload)
            }
        },
    }
}

/** cordis 插件显示名。 */
export const name = 'deepseek'

/** 依赖 ctx.llm 才能注册 provider。 */
export const inject = ['llm']

/** 把 DeepSeek provider 注册到 `ctx.llm`。 */
export function apply(ctx: Context, config: DeepSeekConfig = {}): void {
    ctx.llm.register(createDeepSeekProvider(config))
}
