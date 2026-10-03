import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
    abortError,
    type ToolDefinition,
    type ToolExecution,
    ToolRegistry,
    toText,
} from '../src/core/tool.ts'
import * as tools from '../src/plugins/tools.ts'

// D3 验收：注册表 + OpenAI function schema + 统一执行结果。
// 每个用例一个独立的 ToolRegistry / Context。

function echoTool(): ToolDefinition {
    return {
        name: 'echo',
        description: 'echo back',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async (args) => args,
    }
}

test('register() 返回幂等 disposer，schemas() 是 OpenAI function 形状且不泄漏实现', async () => {
    const registry = new ToolRegistry()
    const dispose = registry.register(echoTool())

    assert.equal(registry.list().length, 1)
    assert.deepEqual(registry.schemas(), [
        {
            type: 'function',
            function: {
                name: 'echo',
                description: 'echo back',
                parameters: { type: 'object', properties: { text: { type: 'string' } } },
            },
        },
    ])

    const [schema] = registry.schemas()
    assert.ok(schema)
    assert.equal(Object.hasOwn(schema, 'execute'), false)
    assert.equal(Object.hasOwn(schema.function, 'render'), false)

    dispose()
    dispose()
    assert.equal(registry.list().length, 0)
})

test('未知工具返回 isError: true，而不是抛异常', async () => {
    const registry = new ToolRegistry()

    const result = await registry.execute({ id: 'c9', name: 'nope', arguments: {} })

    assert.equal(result.isError, true)
    assert.equal(result.toolCallId, 'c9')
    assert.equal(result.name, 'nope')
    assert.match(result.content, /Unknown tool: nope/)
})

test('execute 内部抛错被收敛成 ToolResult，不打断后续执行', async () => {
    const registry = new ToolRegistry()
    registry.register({
        name: 'boom',
        description: 'always throws',
        parameters: { type: 'object' },
        execute: async () => {
            throw new Error('kaboom')
        },
    })
    registry.register(echoTool())

    const failed = await registry.execute({ id: 'c1', name: 'boom', arguments: {} })
    assert.equal(failed.isError, true)
    assert.match(failed.content, /ToolError: kaboom/)

    // run 没有被中断：下一个工具照常执行。
    const ok = await registry.execute({ id: 'c2', name: 'echo', arguments: { text: 'hi' } })
    assert.equal(ok.isError, false)
    assert.equal(ok.content, toText({ text: 'hi' }))
    assert.deepEqual(ok.value, { text: 'hi' })
})

test('render() 覆盖默认输出投影；缺省时把返回值 JSON 序列化', async () => {
    const registry = new ToolRegistry()
    registry.register({
        name: 'pretty',
        description: '',
        parameters: { type: 'object' },
        execute: async () => ({ a: 1 }),
        render: (_args, value) => [{ type: 'text', text: `rendered ${JSON.stringify(value)}` }],
    })
    registry.register({
        name: 'raw',
        description: '',
        parameters: { type: 'object' },
        execute: async () => ({ a: 1 }),
    })

    const rendered = await registry.execute({ id: 'c1', name: 'pretty', arguments: {} })
    assert.equal(rendered.content, 'rendered {"a":1}')

    const raw = await registry.execute({ id: 'c2', name: 'raw', arguments: {} })
    assert.equal(raw.content, toText({ a: 1 }))
    assert.equal(raw.content, JSON.stringify({ a: 1 }, null, 2))
})

test('重复注册与非法定义会抛可读错误', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())

    assert.throws(() => registry.register(echoTool()), /duplicate tool name: echo/)
    assert.throws(
        () =>
            registry.register({
                name: '',
                description: '',
                parameters: {},
                execute: async () => '',
            }),
        /tool.name is required/,
    )
    assert.throws(
        () =>
            registry.register({
                name: 'noexec',
                description: '',
                parameters: {},
            } as unknown as ToolDefinition),
        /tool "noexec" is missing execute\(\)/,
    )
})

test('执行上下文被规范化后传给工具实现', async () => {
    const registry = new ToolRegistry()
    const controller = new AbortController()
    let seen: ToolExecution | undefined

    registry.register({
        name: 'spy',
        description: '',
        parameters: { type: 'object' },
        execute: async (_args, exec) => {
            seen = exec
            return 'ok'
        },
    })

    await registry.execute(
        { id: 'call-1', name: 'spy', arguments: { x: 1 } },
        { sessionId: 's1', cwd: 'C:/ws', signal: controller.signal },
    )

    assert.equal(seen?.toolCallId, 'call-1')
    assert.equal(seen?.sessionId, 's1')
    assert.equal(seen?.cwd, 'C:/ws')
    assert.equal(seen?.signal, controller.signal)
})

test('取消（AbortError）穿透执行流水线，不收敛成 ToolResult', async () => {
    const registry = new ToolRegistry()
    registry.register({
        name: 'cancel',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
            throw abortError('stopped')
        },
    })

    await assert.rejects(
        () => registry.execute({ id: 'c1', name: 'cancel', arguments: {} }),
        (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )

    const pre = new AbortController()
    pre.abort()
    await assert.rejects(
        () => registry.execute({ id: 'c2', name: 'cancel', arguments: {} }, { signal: pre.signal }),
        (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
})

test('ctx.tools 注册绑定到调用方 fiber：调用方卸载即注销，service 卸载即消失', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(tools)
    await serviceFiber

    const service = ctx.tools
    assert.deepEqual(service.schemas(), [])

    // 在插件内注册：disposer 属于该插件的 fiber，而不是 tools provider 的 fiber。
    const toolFiber = ctx.plugin({
        name: 'echo-tools',
        inject: ['tools'],
        apply(ctx: Context) {
            ctx.tools.register(echoTool())
        },
    })
    await toolFiber
    assert.equal(service.has('echo'), true)
    assert.equal(service.schemas().length, 1)

    await toolFiber.dispose()
    assert.equal(service.has('echo'), false)

    // tools provider 卸载：ctx.tools 本身消失。
    await serviceFiber.dispose()
    assert.equal(ctx.tools, undefined)
})
