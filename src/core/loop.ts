import type { LlmRuntime, ModelResponse } from './llm.ts'
import type { ToolCall } from './message.ts'
import type { SessionStore } from './session.ts'
import {
    type ApprovalPort,
    abortError,
    isAbortError,
    type SandboxPort,
    type ToolRegistry,
    type ToolResult,
} from './tool.ts'

/**
 * D5：model → tool → model 的推进器。纯逻辑，不 import cordis。
 *
 * 核心不变式：只要往日志里写了 `assistant/tool_calls`，就一定为其中**每一个**
 * tool_call 写一条配对的 `tool/result` —— 即使中途被取消。否则投影出的 assistant
 * 消息里有 tool_calls、却没有对应 tool 回复，之后这个 session 的每次请求都会被拒绝。
 */

/** 一次 run 的控制与观察钩子。 */
export interface RunOptions {
    signal?: AbortSignal
    /** 显式步数上限；缺省无上限（没有隐藏的步数天花板）。 */
    maxRounds?: number
    onContent?: (chunk: string) => void
    onReasoning?: (chunk: string) => void
    onAssistant?: (response: ModelResponse) => void
    onToolResult?: (result: ToolResult) => void
}

/** 一次 run 的完整参数。 */
export interface RunParams extends RunOptions {
    sessionId: string
    model: string
    input?: string
}

/**
 * 一次 run 的正常结束原因。
 *
 * 取消**不**在这里：取消会先把事件日志补一致，再抛 `AbortError`（ROADMAP D5 的坑）。
 */
export interface RunResult {
    sessionId: string
    stopReason: 'assistant' | 'maxRounds'
    rounds: number
    content?: string
}

/** Agent Loop 的依赖；全是 core 运行时，便于直接单测。 */
export interface LoopDeps {
    sessions: SessionStore
    tools: ToolRegistry
    llm: LlmRuntime
    /** 每一步重新调用：时间 / cwd 必须保持新鲜，不是模型知识。 */
    system?: () => string | Promise<string>
    /** 每次工具批次重新解析：审批 / sandbox 都是可卸载的插件。 */
    ports?: () => ToolPorts
}

/** 传给工具执行的端口；两个能力都可选，缺失时工具自己 fail closed。 */
export interface ToolPorts {
    approval?: ApprovalPort
    sandbox?: SandboxPort
}

function cancelledResult(call: ToolCall): ToolResult {
    return {
        toolCallId: call.id,
        name: call.name,
        content: 'Cancelled by user',
        isError: true,
    }
}

/** Agent Loop。 */
export class AgentLoopRuntime {
    readonly #deps: LoopDeps

    constructor(deps: LoopDeps) {
        this.#deps = deps
    }

    async run(params: RunParams): Promise<RunResult> {
        const { sessions } = this.#deps
        const maxRounds = params.maxRounds ?? Number.POSITIVE_INFINITY

        if (params.input !== undefined) {
            sessions.append(params.sessionId, 'user/message', { content: params.input })
        }

        let rounds = 0
        while (true) {
            // 取消发生在两轮之间时，日志本来就是一致的，直接抛。
            if (params.signal?.aborted) throw abortError()
            if (rounds >= maxRounds) {
                return { sessionId: params.sessionId, stopReason: 'maxRounds', rounds }
            }
            rounds += 1

            const system = this.#deps.system ? await this.#deps.system() : ''
            const response = await this.#deps.llm.complete({
                model: params.model,
                system,
                messages: sessions.deriveMessages(params.sessionId),
                tools: this.#deps.tools.schemas(),
                signal: params.signal,
                onContent: params.onContent,
                onReasoning: params.onReasoning,
            })
            params.onAssistant?.(response)

            // 没有 tool_calls：这就是最终回答。
            if (response.toolCalls.length === 0) {
                sessions.append(params.sessionId, 'assistant/message', {
                    content: response.content,
                    ...(response.reasoningContent
                        ? { reasoningContent: response.reasoningContent }
                        : {}),
                })
                return {
                    sessionId: params.sessionId,
                    stopReason: 'assistant',
                    rounds,
                    content: response.content,
                }
            }

            sessions.append(params.sessionId, 'assistant/tool_calls', {
                ...(response.content ? { content: response.content } : {}),
                ...(response.reasoningContent
                    ? { reasoningContent: response.reasoningContent }
                    : {}),
                toolCalls: response.toolCalls,
            })

            const { cancelled } = await this.#runToolBatch(params, response.toolCalls)
            if (cancelled) throw abortError()
        }
    }

    /**
     * 执行一个工具批次，并为每个 tool_call 落入一条 `tool/result`。
     *
     * 一旦取消：当前及之后的所有 call 都写成 `isError` 的取消结果，
     * 然后由 `run()` 抛 AbortError —— 先补日志，再抛异常。
     */
    async #runToolBatch(params: RunParams, calls: ToolCall[]): Promise<{ cancelled: boolean }> {
        const { sessions, tools } = this.#deps
        let cancelled = false

        for (const call of calls) {
            let result: ToolResult
            if (cancelled || params.signal?.aborted) {
                cancelled = true
                result = cancelledResult(call)
            } else {
                try {
                    const ports = this.#deps.ports?.() ?? {}
                    result = await tools.execute(call, {
                        sessionId: params.sessionId,
                        signal: params.signal,
                        ...ports,
                    })
                } catch (error) {
                    if (!isAbortError(error)) throw error
                    cancelled = true
                    result = cancelledResult(call)
                }
            }

            sessions.append(params.sessionId, 'tool/result', {
                toolCallId: result.toolCallId,
                content: result.content,
                isError: result.isError,
            })
            params.onToolResult?.(result)
        }

        return { cancelled }
    }
}
