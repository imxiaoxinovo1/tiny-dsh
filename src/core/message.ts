/**
 * 模型消息与工具调用的共享类型。
 *
 * `session`（投影）与 `tool`（执行）都要用这些形状，所以单独放在这里，
 * 避免两个 core 文件互相定义一个重复的 tool_call。
 */

/** 工具参数的 JSON Schema（OpenAI function `parameters` 的子集）。 */
export type JsonSchema = Record<string, unknown>

/** 工具输出块；D3 只有文本，未来可扩展图片等。 */
export type ContentBlock = { type: 'text'; text: string }

/** 模型侧的一个 tool_call：`arguments` 是**已解析**的值。 */
export interface ToolCall {
    id: string
    name: string
    arguments: unknown
}

/** OpenAI Chat Completions 兼容的 tool_call：`arguments` 是 JSON 字符串。 */
export interface ChatToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
}

/**
 * OpenAI Chat Completions 兼容的请求消息。
 *
 * 用 wire 形状（snake_case）而不是内部驼峰，是为了让 D4 的 provider 几乎零转换：
 * `deriveMessages()` 的输出可以直接塞进 request body。
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    /** 只在与 assistant 消息同时存在时投影，供展示 / E2 计量。 */
    reasoning_content?: string
    tool_calls?: ChatToolCall[]
    tool_call_id?: string
}
