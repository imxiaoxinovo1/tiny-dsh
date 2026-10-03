import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPromptRuntime } from '../src/core/prompt.ts'
import * as agentLoop from '../src/plugins/agent-loop.ts'
import * as agents from '../src/plugins/agents.ts'
import * as llm from '../src/plugins/llm.ts'
import * as runtimeContext from '../src/plugins/runtime-context.ts'
import * as sessions from '../src/plugins/sessions.ts'
import * as systemPrompt from '../src/plugins/system-prompt.ts'
import * as tools from '../src/plugins/tools.ts'

// D6 验收：按 order 组装 + 空片段跳过 + 工厂每次 assemble 重新调用。

test('按 order 组装，相同 order 保持注册顺序', async () => {
    const prompt = new SystemPromptRuntime()
    prompt.section({ name: 'b', order: 20, text: 'B' })
    prompt.section({ name: 'a', order: 10, text: 'A' })
    prompt.section({ name: 'c', order: 20, text: 'C' })
    prompt.section({ name: 'z', text: 'Z' }) // 缺省 order 0

    assert.equal(await prompt.assemble(), 'Z\n\nA\n\nB\n\nC')
    assert.deepEqual(
        prompt.list().map((entry) => entry.name),
        ['z', 'a', 'b', 'c'],
    )
})

test('空片段被跳过：空串、纯空白、工厂返回空；非空片段被 trim', async () => {
    const prompt = new SystemPromptRuntime()
    prompt.section({ name: 'empty', order: 1, text: '' })
    prompt.section({ name: 'blank', order: 2, text: '   ' })
    prompt.section({ name: 'factory', order: 3, text: () => '' })

    assert.equal(await prompt.assemble(), '')

    prompt.section({ name: 'real', order: 4, text: '  real  ' })
    assert.equal(await prompt.assemble(), 'real')
})

test('工厂函数每次 assemble 都重新调用（同步 + 异步）', async () => {
    const prompt = new SystemPromptRuntime()
    let syncCalls = 0
    let asyncCalls = 0
    prompt.section({ name: 'sync', order: 1, text: () => `s${++syncCalls}` })
    prompt.section({ name: 'async', order: 2, text: async () => `a${++asyncCalls}` })

    assert.equal(await prompt.assemble(), 's1\n\na1')
    assert.equal(await prompt.assemble(), 's2\n\na2')
    assert.equal(syncCalls, 2)
    assert.equal(asyncCalls, 2)
})

test('context() 表达动态状态，与 section 共享 order 空间', async () => {
    const prompt = new SystemPromptRuntime()
    let tick = 0
    prompt.context({ name: 'runtime', order: 100, text: () => `time=${++tick}` })
    prompt.section({ name: 'identity', order: 10, text: 'I am an agent.' })

    assert.deepEqual(prompt.list(), [
        { name: 'identity', order: 10, kind: 'section' },
        { name: 'runtime', order: 100, kind: 'context' },
    ])
    assert.equal(await prompt.assemble(), 'I am an agent.\n\ntime=1')
    assert.equal(await prompt.assemble(), 'I am an agent.\n\ntime=2')
})

test('disposer 幂等；旧 disposer 不会误删同名新片段', async () => {
    const prompt = new SystemPromptRuntime()
    const first = prompt.section({ name: 'x', order: 1, text: 'first' })
    first()
    first()

    const second = prompt.section({ name: 'x', order: 1, text: 'second' })
    first()
    assert.equal(await prompt.assemble(), 'second')

    second()
    assert.equal(await prompt.assemble(), '')
})

test('非法定义与重复注册会抛可读错误', () => {
    const prompt = new SystemPromptRuntime()

    assert.throws(
        () => prompt.section({ name: '', order: 1, text: 'x' }),
        /section.name is required/,
    )
    assert.throws(
        () => prompt.section({ name: 'bad', order: Number.NaN, text: 'x' }),
        /order must be a finite number/,
    )

    prompt.section({ name: 'dup', order: 1, text: 'x' })
    assert.throws(
        () => prompt.section({ name: 'dup', order: 2, text: 'y' }),
        /duplicate section: dup/,
    )

    assert.throws(
        () =>
            prompt.context({
                name: 'ctx',
                order: 1,
                text: 'not a function' as unknown as () => string,
            }),
        /must be a factory function/,
    )
})

test('ctx.systemPrompt：片段绑定到调用方 fiber，卸载即移除', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(systemPrompt)
    await serviceFiber
    assert.equal(await ctx.systemPrompt.assemble(), '')

    const sectionFiber = ctx.plugin({
        name: 'greeting-section',
        inject: ['systemPrompt'],
        apply(ctx: Context) {
            ctx.systemPrompt.section({ name: 'greet', order: 1, text: 'hello' })
        },
    })
    await sectionFiber
    assert.equal(await ctx.systemPrompt.assemble(), 'hello')

    await sectionFiber.dispose()
    assert.equal(await ctx.systemPrompt.assemble(), '')

    await serviceFiber.dispose()
    assert.equal(ctx.systemPrompt, undefined)
})

test('runtime-context 与 agent-loop 集成：每一步重新组装并进入模型请求', async () => {
    const ctx = new Context()
    await ctx.plugin(sessions)
    await ctx.plugin(tools)
    await ctx.plugin(llm)
    await ctx.plugin(systemPrompt)
    await ctx.plugin(agentLoop)
    await ctx.plugin(agents)
    await ctx.plugin(runtimeContext, {
        workspace: process.cwd(),
        now: () => new Date('2026-01-01T00:00:00.000Z'),
    })

    let tick = 0
    ctx.systemPrompt.context({ name: 'test:tick', order: 5, text: () => `tick=${++tick}` })

    ctx.tools.register({
        name: 'noop',
        description: '',
        parameters: { type: 'object' },
        execute: async () => 'ok',
    })

    const systems: string[] = []
    let step = 0
    ctx.llm.register({
        name: 'mock',
        async *stream(request) {
            systems.push(request.system ?? '')
            step += 1
            if (step === 1) {
                yield { type: 'tool_call', index: 0, id: 't1', name: 'noop', arguments: '{}' }
                return
            }
            yield { type: 'content', text: 'done' }
        },
    })

    const session = ctx.sessions.create()
    const agent = ctx.agents.create({ sessionId: session.id, model: 'mock/demo' })
    const result = await agent.run('go')

    assert.equal(result.stopReason, 'assistant')
    assert.equal(systems.length, 2)
    // 工厂每一步都被重新调用：同一个 run 的两次请求拿到不同 tick。
    assert.match(systems[0] ?? '', /tick=1/)
    assert.match(systems[1] ?? '', /tick=2/)
    // 身份 section 与环境 context 都在。
    assert.match(systems[1] ?? '', /general-purpose coding agent/)
    assert.match(systems[1] ?? '', /Current time: 2026-01-01T00:00:00.000Z/)
    assert.match(systems[1] ?? '', /Workspace: /)
})
