import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
    type ChatMessage,
    deriveMessages,
    SessionStore,
    serializeToolArguments,
} from '../src/core/session.ts'
import * as sessions from '../src/plugins/sessions.ts'

// D2 验收：Session 存事件、deriveMessages() 做投影。
// 每个用例一个独立的 SessionStore / Context。

test('事件日志投影出完整的 tool_call 往返（user → tool_calls → result → message）', () => {
    const store = new SessionStore()
    const session = store.create({ title: 'demo' })

    store.append(session.id, 'user/message', { content: '现在几点？' })
    store.append(session.id, 'assistant/tool_calls', {
        reasoningContent: '先调用 clock 拿时间',
        toolCalls: [{ id: 'c1', name: 'clock', arguments: {} }],
    })
    store.append(session.id, 'tool/result', { toolCallId: 'c1', content: '12:00' })
    store.append(session.id, 'assistant/message', { content: '现在是 12:00' })

    const messages = store.deriveMessages(session.id)
    assert.deepEqual(messages, [
        { role: 'user', content: '现在几点？' },
        {
            role: 'assistant',
            content: null,
            reasoning_content: '先调用 clock 拿时间',
            tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'clock', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '12:00' },
        { role: 'assistant', content: '现在是 12:00' },
    ] satisfies ChatMessage[])
})

test('投影时 tool_calls.arguments 重新序列化成 JSON 字符串，字符串输入原样透传', () => {
    const store = new SessionStore()
    const session = store.create()

    store.append(session.id, 'assistant/tool_calls', {
        toolCalls: [
            { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'hi' } },
            { id: 'c2', name: 'noop', arguments: '{"already":"json"}' },
        ],
    })

    const [message] = store.deriveMessages(session.id)
    const [first, second] = message?.tool_calls ?? []
    assert.ok(first && second)
    assert.equal(typeof first.function.arguments, 'string')
    assert.deepEqual(JSON.parse(first.function.arguments), { path: 'a.txt', content: 'hi' })
    assert.equal(second.function.arguments, '{"already":"json"}')

    assert.equal(serializeToolArguments(undefined), '{}')
})

test('reasoning_content 随 assistant/tool_calls 与 assistant/message 一起保留', () => {
    const store = new SessionStore()
    const session = store.create()

    store.append(session.id, 'assistant/tool_calls', {
        reasoningContent: 'think-1',
        toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }],
    })
    store.append(session.id, 'assistant/message', { content: 'done', reasoningContent: 'think-2' })

    const messages = store.deriveMessages(session.id)
    assert.equal(messages[0]?.reasoning_content, 'think-1')
    assert.equal(messages[1]?.reasoning_content, 'think-2')

    // 没有 reasoning 时不产生该字段，避免把空串塞进请求。
    store.clear(session.id)
    store.append(session.id, 'assistant/message', { content: 'plain' })
    const [plain] = store.deriveMessages(session.id)
    assert.ok(plain)
    assert.equal(Object.hasOwn(plain, 'reasoning_content'), false)
})

test('clear() 保持 id / createdAt 不变、投影为空，且事件只追加', () => {
    const store = new SessionStore()
    const session = store.create()
    const { id, createdAt } = session

    store.append(id, 'user/message', { content: 'hello' })
    store.append(id, 'assistant/message', { content: 'hi' })
    const before = session.events.length

    store.clear(id)

    assert.equal(store.get(id)?.id, id)
    assert.equal(store.get(id)?.createdAt, createdAt)
    assert.deepEqual(store.deriveMessages(id), [])
    // 不变式：事件只追加，reset 只是投影边界，历史没有被删除。
    assert.equal(session.events.length, before + 1)
    assert.equal(session.events.at(-1)?.type, 'session/reset')
})

test('append() 分配单调 seq，未知事件类型不进投影', () => {
    const store = new SessionStore()
    const session = store.create()

    const first = store.append(session.id, 'user/message', { content: 'a' })
    const second = store.append(session.id, 'goal/created', { objective: 'x' })
    const third = store.append(session.id, 'assistant/message', { content: 'b' })

    assert.equal(first.seq, 1)
    assert.equal(second.seq, 2)
    assert.equal(third.seq, 3)
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/)

    const messages = store.deriveMessages(session.id)
    assert.deepEqual(
        messages.map((message) => message.role),
        ['user', 'assistant'],
    )
})

test('get / require / delete / list 的边界行为', () => {
    const store = new SessionStore()
    const session = store.create({ title: 'titled' })
    store.append(session.id, 'user/message', { content: 'hi' })

    assert.equal(store.get('missing'), undefined)
    assert.throws(() => store.require('missing'), /session "missing" not found/)
    assert.throws(() => store.append('missing', 'user/message', { content: 'x' }), /not found/)

    assert.deepEqual(store.list(), [
        { id: session.id, createdAt: session.createdAt, title: 'titled', eventCount: 1 },
    ])

    assert.equal(store.delete(session.id), true)
    assert.equal(store.delete(session.id), false)
    assert.deepEqual(store.list(), [])
})

test('派生的凭空事件日志投影与 store 一致（deriveMessages 是纯函数）', () => {
    assert.deepEqual(deriveMessages([]), [])
    const events = [
        { seq: 1, type: 'user/message', data: { content: 'x' }, at: '2026-01-01T00:00:00.000Z' },
    ]
    assert.deepEqual(deriveMessages(events), [{ role: 'user', content: 'x' }])
})

test('ctx.sessions 服务可用，卸载插件后消失', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(sessions)
    await fiber

    assert.ok(ctx.sessions)
    const session = ctx.sessions.create()
    ctx.sessions.append(session.id, 'user/message', { content: 'hi' })
    assert.deepEqual(ctx.sessions.deriveMessages(session.id), [{ role: 'user', content: 'hi' }])
    assert.equal(ctx.sessions.list().length, 1)

    await fiber.dispose()
    assert.equal(ctx.sessions, undefined)
})
