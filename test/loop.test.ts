import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRuntime } from '../src/core/agent.ts'
import { LlmRuntime, type ModelRequest } from '../src/core/llm.ts'
import { AgentLoopRuntime } from '../src/core/loop.ts'
import { SessionStore } from '../src/core/session.ts'
import { abortError, ToolRegistry } from '../src/core/tool.ts'
import * as agentLoop from '../src/plugins/agent-loop.ts'
import * as agents from '../src/plugins/agents.ts'
import * as llm from '../src/plugins/llm.ts'
import * as sessions from '../src/plugins/sessions.ts'
import * as tools from '../src/plugins/tools.ts'

// D5 验收：一次完整工具往返、取消后 tool_call 配对、20 轮无隐藏上限。
// 大部分用例直接用 core 运行时（不起 Context），插件层单独收口。

function makeStack() {
    const sessions = new SessionStore()
    const tools = new ToolRegistry()
    const llm = new LlmRuntime()
    return { sessions, tools, llm, loop: new AgentLoopRuntime({ sessions, tools, llm }) }
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

test('mock model 下完成一次完整工具往返', async () => {
    const { sessions, tools, llm, loop } = makeStack()
    let modelCalls = 0

    tools.register({
        name: 'clock',
        description: 'current time',
        parameters: { type: 'object', properties: {} },
        execute: async () => '2026-08-25T17:25:00+08:00',
    })
    llm.register({
        name: 'mock',
        async *stream(request) {
            modelCalls += 1
            if (modelCalls === 1) {
                yield {
                    type: 'tool_call',
                    index: 0,
                    id: 't1',
                    name: 'clock',
                    arguments: '{}',
                }
                return
            }
            // 第二轮：模型应该能看到上一轮的 tool/result。
            const last = request.messages.at(-1)
            assert.equal(last?.role, 'tool')
            yield { type: 'content', text: `it is ${last?.content}` }
        },
    })

    const session = sessions.create()
    const result = await loop.run({ sessionId: session.id, model: 'mock/demo', input: '几点？' })

    assert.equal(result.stopReason, 'assistant')
    assert.equal(result.rounds, 2)
    assert.equal(modelCalls, 2)
    assert.match(result.content ?? '', /2026-08-25/)

    const messages = sessions.deriveMessages(session.id)
    assert.deepEqual(
        messages.map((message) => message.role),
        ['user', 'assistant', 'tool', 'assistant'],
    )
    assert.equal(messages[1]?.tool_calls?.[0]?.id, 't1')
    assert.equal(messages[1]?.tool_calls?.[0]?.function.arguments, '{}')
    assert.equal(messages[2]?.tool_call_id, 't1')
})

test('取消多工具轮次：每个 tool_call 都有配对的 tool/result，然后抛 AbortError', async () => {
    const { sessions, tools, llm, loop } = makeStack()
    const controller = new AbortController()

    tools.register({
        name: 'slow',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
            // 第一个工具执行中途取消。
            controller.abort()
            return 'first result'
        },
    })
    llm.register({
        name: 'mock',
        async *stream() {
            yield { type: 'tool_call', index: 0, id: 't1', name: 'slow', arguments: '{}' }
            yield { type: 'tool_call', index: 1, id: 't2', name: 'slow', arguments: '{}' }
        },
    })

    const session = sessions.create()
    await assert.rejects(
        () =>
            loop.run({
                sessionId: session.id,
                model: 'mock/demo',
                input: 'run both',
                signal: controller.signal,
            }),
        isAbort,
    )

    // 坑：先补日志再抛 —— 投影出的请求必须始终合法。
    const messages = sessions.deriveMessages(session.id)
    const requested = messages
        .filter((message) => message.tool_calls)
        .flatMap((message) => message.tool_calls?.map((call) => call.id) ?? [])
    const answered = messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.tool_call_id)
    assert.deepEqual(requested, ['t1', 't2'])
    assert.deepEqual(answered, ['t1', 't2'])

    const cancelledEvent = session.events.at(-1)
    assert.equal(cancelledEvent?.type, 'tool/result')
    assert.equal((cancelledEvent?.data as { isError?: boolean } | undefined)?.isError, true)
})

test('连续 20 次工具调用后仍能正常结束（没有隐藏步数上限）', async () => {
    const { sessions, tools, llm, loop } = makeStack()
    let modelCalls = 0

    tools.register({
        name: 'tick',
        description: '',
        parameters: { type: 'object' },
        execute: async () => 'ok',
    })
    llm.register({
        name: 'mock',
        async *stream() {
            modelCalls += 1
            if (modelCalls <= 20) {
                yield {
                    type: 'tool_call',
                    index: 0,
                    id: `t${modelCalls}`,
                    name: 'tick',
                    arguments: '{}',
                }
                return
            }
            yield { type: 'content', text: 'done' }
        },
    })

    const session = sessions.create()
    const result = await loop.run({ sessionId: session.id, model: 'mock/long', input: 'go' })

    assert.equal(result.stopReason, 'assistant')
    assert.equal(result.rounds, 21)
    assert.equal(modelCalls, 21)
    assert.equal(
        sessions.deriveMessages(session.id).filter((message) => message.role === 'tool').length,
        20,
    )
})

test('显式 maxRounds 生效，默认则无上限', async () => {
    const { sessions, tools, llm, loop } = makeStack()
    tools.register({
        name: 'tick',
        description: '',
        parameters: { type: 'object' },
        execute: async () => 'ok',
    })
    llm.register({
        name: 'mock',
        async *stream() {
            yield { type: 'tool_call', index: 0, id: 't', name: 'tick', arguments: '{}' }
        },
    })

    const session = sessions.create()
    const result = await loop.run({
        sessionId: session.id,
        model: 'mock/demo',
        input: 'go',
        maxRounds: 3,
    })

    assert.equal(result.stopReason, 'maxRounds')
    assert.equal(result.rounds, 3)
})

test('无 tool_calls 时写 assistant/message 并保留 reasoning；system 每步重新组装', async () => {
    const { sessions, tools, llm } = makeStack()
    const systems: string[] = []
    let step = 0

    tools.register({
        name: 'noop',
        description: '',
        parameters: { type: 'object' },
        execute: async () => 'ok',
    })
    llm.register({
        name: 'mock',
        async *stream(request) {
            systems.push(request.system ?? '')
            step += 1
            if (step === 1) {
                yield { type: 'reasoning', text: 'think' }
                yield { type: 'tool_call', index: 0, id: 't1', name: 'noop', arguments: '{}' }
                return
            }
            yield { type: 'content', text: 'final' }
        },
    })

    const session = sessions.create()
    const local = new AgentLoopRuntime({
        sessions,
        tools,
        llm,
        system: () => `system-${systems.length + 1}`,
    })
    const result = await local.run({ sessionId: session.id, model: 'mock/demo', input: 'go' })

    assert.equal(result.content, 'final')
    assert.deepEqual(systems, ['system-1', 'system-2'])

    const messages = sessions.deriveMessages(session.id)
    assert.equal(messages[1]?.reasoning_content, 'think')
    assert.equal(messages[3]?.role, 'assistant')
    assert.equal(messages[3]?.content, 'final')
})

test('工具内部抛错被收敛为 isError，run 继续到最终回答', async () => {
    const { sessions, tools, llm, loop } = makeStack()
    let step = 0

    tools.register({
        name: 'boom',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
            throw new Error('boom')
        },
    })
    llm.register({
        name: 'mock',
        async *stream() {
            step += 1
            if (step === 1) {
                yield { type: 'tool_call', index: 0, id: 't1', name: 'boom', arguments: '{}' }
                return
            }
            yield { type: 'content', text: 'recovered' }
        },
    })

    const session = sessions.create()
    const result = await loop.run({ sessionId: session.id, model: 'mock/demo', input: 'go' })

    assert.equal(result.content, 'recovered')
    const toolEvent = session.events.find((event) => event.type === 'tool/result')
    assert.equal((toolEvent?.data as { isError?: boolean } | undefined)?.isError, true)
})

test('Agent.cancel() 中止在飞的 run，日志仍保持配对', async () => {
    const { sessions, tools, llm, loop } = makeStack()
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
        notifyStarted = resolve
    })

    tools.register({
        name: 'hang',
        description: '',
        parameters: { type: 'object' },
        execute: async (_args, exec) => {
            notifyStarted?.()
            return new Promise((_resolve, reject) => {
                exec.signal.addEventListener('abort', () => reject(abortError()))
            })
        },
    })
    llm.register({
        name: 'mock',
        async *stream() {
            yield { type: 'tool_call', index: 0, id: 't1', name: 'hang', arguments: '{}' }
            yield { type: 'tool_call', index: 1, id: 't2', name: 'hang', arguments: '{}' }
        },
    })

    const session = sessions.create()
    const runtime = new AgentRuntime((agent, input, options) =>
        loop.run({ sessionId: agent.sessionId, model: agent.model, input, ...options }),
    )
    const agent = runtime.create({ sessionId: session.id, model: 'mock/demo' })

    const running = agent.run('go')
    await started
    assert.equal(agent.running, true)

    agent.cancel()
    await assert.rejects(running, isAbort)
    assert.equal(agent.running, false)

    const messages = sessions.deriveMessages(session.id)
    const requested = messages
        .filter((message) => message.tool_calls)
        .flatMap((message) => message.tool_calls?.map((call) => call.id) ?? [])
    const answered = messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.tool_call_id)
    assert.deepEqual(requested, ['t1', 't2'])
    assert.deepEqual(answered, ['t1', 't2'])
})

test('插件层端到端：sessions/tools/llm/agentLoop/agents 串成一次工具往返', async () => {
    const ctx = new Context()
    await ctx.plugin(sessions)
    await ctx.plugin(tools)
    await ctx.plugin(llm)
    await ctx.plugin(agentLoop)
    await ctx.plugin(agents)

    ctx.tools.register({
        name: 'echo',
        description: '',
        parameters: { type: 'object' },
        execute: async (args) => args,
    })
    ctx.llm.register({
        name: 'mock',
        async *stream(request: ModelRequest) {
            const last = request.messages.at(-1)
            if (last?.role === 'tool') {
                yield { type: 'content', text: `echo:${last.content}` }
                return
            }
            yield {
                type: 'tool_call',
                index: 0,
                id: 't1',
                name: 'echo',
                arguments: '{"text":"hi"}',
            }
        },
    })

    const session = ctx.sessions.create()
    const agent = ctx.agents.create({ sessionId: session.id, model: 'mock/demo' })
    const result = await agent.run('go')

    assert.equal(result.stopReason, 'assistant')
    assert.match(result.content ?? '', /echo:/)
    assert.equal(ctx.agents.list().length, 1)

    const projected = ctx.sessions.deriveMessages(session.id)
    assert.deepEqual(
        projected.map((message) => message.role),
        ['user', 'assistant', 'tool', 'assistant'],
    )
})
