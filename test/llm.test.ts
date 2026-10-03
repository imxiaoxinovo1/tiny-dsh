import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, ModelAssembler, parseChatCompletionChunk, SseParser } from '../src/core/llm.ts'
import * as llm from '../src/plugins/llm.ts'
import { createDeepSeekProvider } from '../src/providers/deepseek.ts'

// D4 验收：SSE 解析边界、tool_calls 增量拼装、Provider 路由。
// 网络全部用可注入的 fake fetch，测试不联网。

/** 一条 SSE 事件（注意结尾是两个换行）。 */
const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

/** 把文本按给定大小切块，模拟 fetch 的 body 流。 */
function sseStream(text: string, sizes: number[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let offset = 0
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const size of sizes) {
                if (offset >= text.length) break
                controller.enqueue(encoder.encode(text.slice(offset, offset + size)))
                offset += size
            }
            if (offset < text.length) controller.enqueue(encoder.encode(text.slice(offset)))
            controller.close()
        },
    })
}

async function drain(chunks: AsyncIterable<unknown>): Promise<void> {
    for await (const chunk of chunks) void chunk
}

const fakeOk = (async () => new Response('', { status: 200 })) as unknown as typeof globalThis.fetch
const fakeUnauthorized = (async () =>
    new Response('bad key', { status: 401 })) as unknown as typeof globalThis.fetch

// ---------- 1. SSE 边界 ----------

test('SseParser 跨 chunk 解析，且最后一行没有换行也能被冲出', () => {
    const parser = new SseParser()

    assert.deepEqual(parser.push('data: {"a"'), [])
    assert.deepEqual(parser.push(':1}\n\ndata: {"b":2}\n'), ['{"a":1}', '{"b":2}'])

    // 末行没有换行结尾：留在缓冲区，由 end() 冲出。
    assert.deepEqual(parser.push('data: {"c":3}'), [])
    assert.deepEqual(parser.end(), ['{"c":3}'])
})

test('SseParser 识别 data:[DONE]（带不带空格、有没有换行都一样）', () => {
    const parser = new SseParser()
    assert.deepEqual(parser.push('data: {"a":1}\ndata:[DONE]\n'), ['{"a":1}'])
    assert.equal(parser.done, true)

    const tail = new SseParser()
    assert.deepEqual(tail.push('data: {"x":1}\ndata: [DONE]'), ['{"x":1}'])
    assert.equal(tail.done, false)
    assert.deepEqual(tail.end(), [])
    assert.equal(tail.done, true)
})

// ---------- 2. 分片拼装 ----------

test('tool_call 分片拼装：name 不重复、arguments 拼接、流结束才 parse', () => {
    const assembler = new ModelAssembler()
    assembler.push({ type: 'reasoning', text: '想一下' })
    assembler.push({ type: 'content', text: 'let me ' })
    assembler.push({ type: 'content', text: 'call' })
    assembler.push({ type: 'tool_call', index: 0, id: 'call_1', name: 'read_file', arguments: '' })
    assembler.push({ type: 'tool_call', index: 0, name: 'read_file', arguments: '{"pa' })
    assembler.push({ type: 'tool_call', index: 0, arguments: 'th":"a.txt"}' })

    const response = assembler.finish()
    assert.equal(response.content, 'let me call')
    assert.equal(response.reasoningContent, '想一下')
    assert.equal(response.toolCalls.length, 1)
    // 关键回归：不能变成 read_fileread_file
    assert.equal(response.toolCalls[0]?.name, 'read_file')
    assert.equal(response.toolCalls[0]?.id, 'call_1')
    assert.deepEqual(response.toolCalls[0]?.arguments, { path: 'a.txt' })
})

test('多个 tool_call 按 index 排序；空 arguments 归一为 {}，非法 JSON 保留原文', () => {
    const assembler = new ModelAssembler()
    assembler.push({ type: 'tool_call', index: 1, id: 'b', name: 'two', arguments: '' })
    assembler.push({ type: 'tool_call', index: 0, id: 'a', name: 'one', arguments: 'not json' })

    const response = assembler.finish()
    assert.deepEqual(
        response.toolCalls.map((call) => call.id),
        ['a', 'b'],
    )
    assert.deepEqual(response.toolCalls[0]?.arguments, 'not json')
    assert.deepEqual(response.toolCalls[1]?.arguments, {})
    assert.equal(response.reasoningContent, undefined)
})

test('parseChatCompletionChunk 映射 DeepSeek delta，非 JSON / 空载荷返回 []', () => {
    const chunks = parseChatCompletionChunk(
        JSON.stringify({
            choices: [
                {
                    delta: {
                        reasoning_content: '',
                        content: 'hi',
                        tool_calls: [
                            { index: 0, id: 'c1', function: { name: 't', arguments: '{}' } },
                        ],
                    },
                },
            ],
        }),
    )

    assert.deepEqual(chunks, [
        { type: 'content', text: 'hi' },
        { type: 'tool_call', index: 0, id: 'c1', name: 't', arguments: '{}' },
    ])
    assert.deepEqual(parseChatCompletionChunk('not json'), [])
    assert.deepEqual(parseChatCompletionChunk('{}'), [])
})

// ---------- 3. Runtime 路由 ----------

test('LlmRuntime 用 provider/model 路由，裸 model 走默认 provider，disposer 注销', async () => {
    const runtime = new LlmRuntime()
    const seen: string[] = []

    const dispose = runtime.register({
        name: 'mock',
        async *stream(request) {
            seen.push(request.model)
            yield { type: 'content', text: 'ok' }
        },
    })
    const disposeOther = runtime.register(
        {
            name: 'other',
            async *stream(request) {
                seen.push(`other:${request.model}`)
                yield { type: 'content', text: 'default' }
            },
        },
        { default: true },
    )

    const routed = await runtime.complete({ model: 'mock/fast', messages: [] })
    assert.equal(routed.content, 'ok')
    assert.equal(seen[0], 'fast')
    assert.equal(runtime.defaultProvider, 'other')

    const fallback = await runtime.complete({ model: 'bare-model', messages: [] })
    assert.equal(fallback.content, 'default')
    assert.equal(seen[1], 'other:bare-model')

    dispose()
    assert.equal(runtime.has('mock'), false)

    // 前缀不再是注册的 provider：退回默认 provider，并透传完整 model 名。
    const afterDispose = await runtime.complete({ model: 'mock/fast', messages: [] })
    assert.equal(afterDispose.content, 'default')
    assert.equal(seen[2], 'other:mock/fast')

    disposeOther()
    await assert.rejects(
        () => runtime.complete({ model: 'bare-model', messages: [] }),
        /no LLM provider registered/,
    )
})

test('complete() 边流边回调 onContent / onReasoning', async () => {
    const runtime = new LlmRuntime()
    runtime.register({
        name: 'streamy',
        async *stream() {
            yield { type: 'reasoning', text: 'r1' }
            yield { type: 'content', text: 'a' }
            yield { type: 'content', text: 'b' }
        },
    })

    const content: string[] = []
    const reasoning: string[] = []
    const response = await runtime.complete({
        model: 'streamy/m',
        messages: [],
        onContent: (chunk) => content.push(chunk),
        onReasoning: (chunk) => reasoning.push(chunk),
    })

    assert.deepEqual(content, ['a', 'b'])
    assert.deepEqual(reasoning, ['r1'])
    assert.equal(response.content, 'ab')
})

// ---------- 4. DeepSeek provider 端到端 ----------

test('DeepSeek provider：SSE → 分片 → ModelResponse（fake fetch）', async () => {
    const payload =
        sse({ choices: [{ delta: { reasoning_content: 'think' } }] }) +
        sse({ choices: [{ delta: { content: 'hi' } }] }) +
        sse({
            choices: [
                {
                    delta: {
                        tool_calls: [
                            { index: 0, id: 'c1', function: { name: 'read_file', arguments: '' } },
                        ],
                    },
                },
            ],
        }) +
        sse({
            choices: [
                {
                    delta: {
                        tool_calls: [
                            { index: 0, function: { name: 'read_file', arguments: '{"path":"a' } },
                        ],
                    },
                },
            ],
        }) +
        sse({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }] } }],
        }) +
        // 最后一条故意没有换行结尾，靠 parser.end() 冲出。
        `data: ${JSON.stringify({ choices: [{ delta: { content: '!' } }] })}`

    let requestUrl = ''
    let requestBody = ''
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(input)
        requestBody = String(init?.body ?? '')
        return new Response(sseStream(payload, [7, 13, 29, 64, 1024]), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const runtime = new LlmRuntime()
    runtime.register(
        createDeepSeekProvider({
            apiKey: 'test-key',
            baseUrl: 'https://example.test/v1/',
            fetch: fakeFetch,
        }),
    )

    const response = await runtime.complete({
        model: 'deepseek/deepseek-v4-flash',
        system: 'be brief',
        messages: [{ role: 'user', content: 'hi' }],
    })

    assert.equal(response.reasoningContent, 'think')
    assert.equal(response.content, 'hi!')
    assert.equal(response.toolCalls.length, 1)
    assert.equal(response.toolCalls[0]?.name, 'read_file')
    assert.deepEqual(response.toolCalls[0]?.arguments, { path: 'a.txt' })

    assert.equal(requestUrl, 'https://example.test/v1/chat/completions')
    const body = JSON.parse(requestBody) as {
        model: string
        stream: boolean
        messages: Array<{ role: string; content: string }>
    }
    assert.equal(body.model, 'deepseek-v4-flash')
    assert.equal(body.stream, true)
    assert.deepEqual(body.messages, [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
    ])
})

test('DeepSeek provider：缺 apiKey 与 HTTP 错误都抛可读错误', async () => {
    const noKey = createDeepSeekProvider({ fetch: fakeOk })
    await assert.rejects(drain(noKey.stream({ model: 'm', messages: [] })), /DEEPSEEK_API_KEY/)

    const unauthorized = createDeepSeekProvider({ apiKey: 'k', fetch: fakeUnauthorized })
    await assert.rejects(drain(unauthorized.stream({ model: 'm', messages: [] })), /HTTP 401/)
})

// ---------- 5. 插件层 ----------

test('ctx.llm 注册 provider 并完成一次调用，卸载插件后消失', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(llm)
    await fiber

    ctx.llm.register({
        name: 'mock',
        async *stream() {
            yield { type: 'content', text: 'hi' }
        },
    })

    assert.deepEqual(
        ctx.llm.list().map((provider) => provider.name),
        ['mock'],
    )
    const response = await ctx.llm.complete({ model: 'mock/x', messages: [] })
    assert.equal(response.content, 'hi')

    await fiber.dispose()
    assert.equal(ctx.llm, undefined)
})
