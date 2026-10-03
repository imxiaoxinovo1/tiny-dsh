import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
    CompactionRuntime,
    isPairedRange,
    type PrunerOptions,
    pickCompactionRange,
    type SummarizeInput,
    type Summarizer,
} from '../src/core/compaction.ts'
import { LlmRuntime } from '../src/core/llm.ts'
import { AgentLoopRuntime } from '../src/core/loop.ts'
import type { ChatMessage } from '../src/core/message.ts'
import { type Session, SessionStore, type SurfaceOp } from '../src/core/session.ts'
import { estimateMessages, estimateRequest, estimateTokens } from '../src/core/token.ts'
import { ToolRegistry } from '../src/core/tool.ts'
import * as compaction from '../src/plugins/compaction.ts'
import * as sessions from '../src/plugins/sessions.ts'
import * as tokenMeter from '../src/plugins/token-meter.ts'

// E2 验收：三个 compaction 事件按序落盘；surfaceOp 替换旧区间；
// 工具大结果先剪枝再重新计量；摘要失败不留假的 end。

function seed(store: SessionStore, turns: number, size = 200): Session {
    const session = store.create({ title: 'compact-me' })
    for (let i = 0; i < turns; i++) {
        store.append(session.id, 'user/message', { content: `user turn ${i} ${'x'.repeat(size)}` })
        store.append(session.id, 'assistant/message', {
            content: `assistant turn ${i} ${'y'.repeat(size)}`,
        })
    }
    return session
}

interface RuntimeOptions {
    maxTokens: number
    keepRecentEvents?: number
    minEvents?: number
    pruner?: Partial<PrunerOptions>
    summarizer?: Summarizer
}

function makeRuntime(store: SessionStore, options: RuntimeOptions) {
    const calls: SummarizeInput[] = []
    const runtime = new CompactionRuntime({
        sessions: store,
        tokenMeter: { countMessages: estimateMessages },
        summarizer:
            options.summarizer ??
            (async (input) => {
                calls.push(input)
                return 'SUMMARY'
            }),
        options: {
            maxTokens: options.maxTokens,
            keepRecentEvents: options.keepRecentEvents,
            minEvents: options.minEvents,
        },
        pruner: options.pruner,
        onError: () => {},
    })
    return { runtime, calls }
}

function compactionTypes(session: Session): string[] {
    return session.events
        .filter((event) => event.type.startsWith('compaction/'))
        .map((event) => event.type)
}

// ---------- token 估算 ----------

test('token 估算：宽字符更重，随内容单调增长', () => {
    assert.equal(estimateTokens(''), 0)
    assert.ok(estimateTokens('a'.repeat(400)) >= 100)
    assert.ok(estimateTokens('中'.repeat(100)) > estimateTokens('a'.repeat(100)))

    const short = estimateMessages([{ role: 'user', content: 'hi' }])
    const long = estimateMessages([{ role: 'user', content: 'hi'.repeat(1000) }])
    assert.ok(long > short)

    const request = estimateRequest({
        system: 'x'.repeat(100),
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 't', description: '', parameters: {} } }],
    })
    assert.ok(request > short)
})

// ---------- 压缩主流程 ----------

test('compaction：start → summary → user/message(surfaceOp) → end 按序落盘', async () => {
    const store = new SessionStore()
    const session = seed(store, 8, 200)
    const { runtime, calls } = makeRuntime(store, {
        maxTokens: 10,
        keepRecentEvents: 2,
        minEvents: 2,
    })

    const messages = await runtime.prepare(session.id)

    assert.deepEqual(compactionTypes(session), [
        'compaction/start',
        'compaction/summary',
        'compaction/end',
    ])

    const replacement = session.events.find(
        (event) =>
            event.type === 'user/message' &&
            (event.data as { surfaceOp?: SurfaceOp } | null)?.surfaceOp !== undefined,
    )
    assert.ok(replacement)
    const op = (replacement.data as { surfaceOp: SurfaceOp }).surfaceOp
    assert.equal(op.op, 'replace')
    assert.ok(op.start < op.end)

    assert.equal(calls.length, 1)
    assert.match(messages[0]?.content ?? '', /SUMMARY/)
})

test('投影：surfaceOp 遮蔽旧区间，summary 消息取而代之，尾部保留', async () => {
    const store = new SessionStore()
    const session = seed(store, 4, 20)
    const { runtime } = makeRuntime(store, { maxTokens: 10, keepRecentEvents: 2, minEvents: 2 })

    assert.equal(await runtime.maybeCompact(session.id), true)

    const messages = store.deriveMessages(session.id)
    assert.match(messages[0]?.content ?? '', /SUMMARY/)
    assert.equal(
        messages.some((message) => (message.content ?? '').includes('user turn 0')),
        false,
    )
    // 尾部两条（第 4 轮）仍在。
    assert.ok(messages.length >= 2)
    assert.match(messages.at(-1)?.content ?? '', /assistant turn 3/)
})

test('compaction：摘要失败只留 start，绝不写 end', async () => {
    const store = new SessionStore()
    const session = seed(store, 8, 200)
    let errors = 0

    const runtime = new CompactionRuntime({
        sessions: store,
        tokenMeter: { countMessages: estimateMessages },
        summarizer: async () => {
            throw new Error('summarizer exploded')
        },
        options: { maxTokens: 10, keepRecentEvents: 2, minEvents: 2 },
        onError: () => {
            errors += 1
        },
    })

    assert.equal(await runtime.maybeCompact(session.id), false)
    assert.equal(errors, 1)
    assert.deepEqual(compactionTypes(session), ['compaction/start'])

    const hasReplacement = session.events.some(
        (event) =>
            event.type === 'user/message' &&
            (event.data as { surfaceOp?: SurfaceOp } | null)?.surfaceOp !== undefined,
    )
    assert.equal(hasReplacement, false)
    assert.equal(store.deriveMessages(session.id).length, 16)
})

test('未超阈值时 prepare 原样返回投影，不动日志', async () => {
    const store = new SessionStore()
    const session = seed(store, 3, 5)
    const { runtime } = makeRuntime(store, { maxTokens: 1_000_000 })

    const messages = await runtime.prepare(session.id)
    assert.equal(messages.length, 6)
    assert.deepEqual(compactionTypes(session), [])
})

// ---------- pruner ----------

test('pruner：工具大结果先截断并重新计量，于是不必触发摘要', async () => {
    const store = new SessionStore()
    const session = store.create()
    store.append(session.id, 'user/message', { content: 'read it' })
    store.append(session.id, 'assistant/tool_calls', {
        toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'big.txt' } }],
    })
    store.append(session.id, 'tool/result', { toolCallId: 't1', content: 'Z'.repeat(5000) })
    store.append(session.id, 'assistant/message', { content: 'done' })

    const { runtime } = makeRuntime(store, {
        maxTokens: 200,
        pruner: { maxToolResultChars: 100, keepRecentMessages: 0 },
    })

    const messages = await runtime.prepare(session.id)
    const toolMessage = messages.find((message) => message.role === 'tool')
    assert.ok(toolMessage)
    assert.match(toolMessage.content ?? '', /truncated by tool-result pruner/)
    assert.ok((toolMessage.content ?? '').length < 200)
    // 剪枝后已经低于阈值：不应产生压缩事件。
    assert.deepEqual(compactionTypes(session), [])
})

// ---------- 区间选择 ----------

test('区间选择不会切开 tool_call / tool_result 配对', () => {
    const store = new SessionStore()
    const session = store.create()
    store.append(session.id, 'user/message', { content: 'q1' })
    store.append(session.id, 'assistant/tool_calls', {
        toolCalls: [{ id: 't1', name: 'x', arguments: {} }],
    })
    store.append(session.id, 'tool/result', { toolCallId: 't1', content: 'r1' })
    store.append(session.id, 'user/message', { content: 'q2' })
    store.append(session.id, 'assistant/tool_calls', {
        toolCalls: [{ id: 't2', name: 'x', arguments: {} }],
    })
    store.append(session.id, 'tool/result', { toolCallId: 't2', content: 'r2' })
    store.append(session.id, 'assistant/message', { content: 'final' })

    const range = pickCompactionRange(session.events, {
        maxTokens: 1,
        keepRecentEvents: 2,
        minEvents: 1,
    })
    assert.ok(range)
    // t2 的 tool_calls 在区间末尾但 result 在尾部 → 必须回退到 4。
    assert.equal(range.end, 4)

    const included = session.events.filter(
        (event) => event.seq >= range.start && event.seq <= range.end,
    )
    assert.equal(isPairedRange(included), true)
})

// ---------- 插件层 ----------

test('插件层：ctx.tokenMeter / ctx.compaction 可用，prepare 产出摘要消息', async () => {
    const ctx = new Context()
    await ctx.plugin(sessions)
    await ctx.plugin(tokenMeter)
    await ctx.plugin(compaction, {
        maxTokens: 10,
        keepRecentEvents: 2,
        minEvents: 2,
        summarizer: async () => 'PLUGIN SUMMARY',
    })

    const session = ctx.sessions.create()
    for (let i = 0; i < 6; i++) {
        ctx.sessions.append(session.id, 'user/message', { content: `u${i} ${'x'.repeat(100)}` })
        ctx.sessions.append(session.id, 'assistant/message', {
            content: `a${i} ${'y'.repeat(100)}`,
        })
    }

    assert.ok(ctx.tokenMeter.countMessages(ctx.sessions.deriveMessages(session.id)) > 10)
    assert.equal(ctx.compaction.maxTokens, 10)

    const messages = await ctx.compaction.prepare(session.id)
    assert.match(messages[0]?.content ?? '', /PLUGIN SUMMARY/)
})

test('agent-loop 集成：compaction.prepare 的结果进入模型请求', async () => {
    const store = new SessionStore()
    const tools = new ToolRegistry()
    const llm = new LlmRuntime()
    const seen: ChatMessage[][] = []

    llm.register({
        name: 'mock',
        async *stream(request) {
            seen.push(request.messages)
            yield { type: 'content', text: 'ok' }
        },
    })

    const loop = new AgentLoopRuntime({
        sessions: store,
        tools,
        llm,
        compaction: () => ({
            prepare: async (sessionId: string) => [
                { role: 'assistant', content: `prepared:${sessionId}` },
            ],
        }),
    })

    const session = store.create()
    await loop.run({ sessionId: session.id, model: 'mock/demo', input: 'hi' })

    assert.equal(seen[0]?.length, 1)
    assert.equal(seen[0]?.[0]?.content, `prepared:${session.id}`)
})
