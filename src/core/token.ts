import type { ChatMessage } from './message.ts'
import type { ToolSchema } from './tool.ts'

/**
 * E2：token 估算。纯启发式，不引入 tokenizer 依赖。
 *
 * - 宽字符（CJK 等，码点 > 0x2e80）按 ~1 字符 1 token；
 * - 其余按 ~4 字符 1 token。
 *
 * 估算只用于「是否触发压缩」的决策，不追求与真实 tokenizer 对齐。
 */

/** 估算一段文本的 token 数。 */
export function estimateTokens(text: string): number {
    let units = 0
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0
        units += code > 0x2e80 ? 1 : 0.25
    }
    return Math.ceil(units)
}

/** 每条消息的固定开销（role、分隔符等）。 */
const MESSAGE_OVERHEAD = 4

/** 估算消息序列的 token 数（含 tool_calls 的 arguments）。 */
export function estimateMessages(messages: readonly ChatMessage[]): number {
    let tokens = 0
    for (const message of messages) {
        tokens += MESSAGE_OVERHEAD
        if (message.content) tokens += estimateTokens(message.content)
        if (message.reasoning_content) tokens += estimateTokens(message.reasoning_content)
        if (message.tool_call_id) tokens += estimateTokens(message.tool_call_id)
        for (const call of message.tool_calls ?? []) {
            tokens += estimateTokens(call.id)
            tokens += estimateTokens(call.function.name)
            tokens += estimateTokens(call.function.arguments)
        }
    }
    return tokens
}

/** 估算一次请求的 token 数：system + messages + tools schema。 */
export function estimateRequest(request: {
    system?: string
    messages: readonly ChatMessage[]
    tools?: readonly ToolSchema[]
}): number {
    let tokens = request.system ? estimateTokens(request.system) : 0
    tokens += estimateMessages(request.messages)
    if (request.tools && request.tools.length > 0) {
        tokens += estimateTokens(JSON.stringify(request.tools))
    }
    return tokens
}
