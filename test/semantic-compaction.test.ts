import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CompactionRuntime, type SummarizeInput } from '../src/core/compaction.ts'
import {
    createSemanticSummarizer,
    type ImportanceJudge,
    type SummaryInput,
    summaryPrompt,
} from '../src/core/semantic-compaction.ts'
import { SessionStore } from '../src/core/session.ts'
import * as compaction from '../src/plugins/compaction.ts'
import * as llmPlugin from '../src/plugins/llm.ts'
import * as sessionsPlugin from '../src/plugins/sessions.ts'
import * as tokenMeter from '../src/plugins/token-meter.ts'
import { createJevJudge } from '../src/providers/jev.ts'

const input: SummarizeInput = {
    sessionId: 's',
    start: 1,
    end: 3,
    task: 'Fix the failure',
    messages: [
        { role: 'user', content: 'Do not upload anything.' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'shell', arguments: '{"command":"pnpm test"}' },
                },
            ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'Exit 1: failure at line 42' },
    ],
}
const judge: ImportanceJudge = async () => ({
    model: 'stub',
    items: [
        { index: 0, score: 3, confidence: 0.9 },
        { index: 1, score: 2, confidence: 0.9 },
        { index: 2, score: 3, confidence: 0.9 },
    ],
})

test('assistance highlights evidence without removing messages or changing call/result pairs', async () => {
    const before = structuredClone(input)
    let received: SummaryInput | undefined
    const summarize = createSemanticSummarizer({
        mode: 'assisted',
        judge,
        summarize: async (draft) => {
            received = draft
            return 'checkpoint'
        },
    })
    assert.equal(await summarize(input), 'checkpoint')
    assert.deepEqual(received?.priorityIndexes, [0, 1, 2])
    assert.equal(received?.messages, input.messages)
    assert.deepEqual(input, before)
    const prompt = summaryPrompt(received as SummaryInput)
    assert.match(prompt, /tool_calls/)
    assert.match(prompt, /pnpm test/)
    assert.match(prompt, /tool_call_id/)
})

test('off makes no judge request; shadow observes without altering summary input', async () => {
    let requests = 0
    for (const mode of ['off', 'shadow'] as const) {
        await createSemanticSummarizer({
            mode,
            judge: async (state) => {
                requests++
                return judge(state)
            },
            summarize: async (draft) => {
                assert.equal(draft, input)
                return 'ok'
            },
        })(input)
    }
    assert.equal(requests, 1)
})

test('judge failure, partial results, duplicate indexes and nonfinite scores fall back', async () => {
    const broken: ImportanceJudge[] = [
        async () => {
            throw new Error('timeout')
        },
        async () => ({ model: 'bad', items: [] }),
        async () => ({
            model: 'bad',
            items: [0, 0, 2].map((index) => ({ index, score: 3, confidence: 1 })),
        }),
        async () => ({
            model: 'bad',
            items: [0, 1, 2].map((index) => ({ index, score: Number.NaN, confidence: 1 })),
        }),
    ]
    for (const invalid of broken) {
        let fallback = false
        const summarize = createSemanticSummarizer({
            mode: 'assisted',
            judge: invalid,
            observe: (value) => {
                fallback = value.outcome === 'fallback'
            },
            summarize: async (draft) => {
                assert.equal(draft, input)
                return 'baseline'
            },
        })
        assert.equal(await summarize(input), 'baseline')
        assert.equal(fallback, true)
    }
})

test('uncertain scores do not highlight messages; observer exceptions do not break summary', async () => {
    const summarize = createSemanticSummarizer({
        mode: 'assisted',
        judge: async () => ({
            model: 'uncertain',
            items: [0, 1, 2].map((index) => ({ index, score: 3, confidence: 0.2 })),
        }),
        observe: () => {
            throw new Error('diagnostic subscriber')
        },
        summarize: async (draft) => {
            assert.equal(draft, input)
            return 'ok'
        },
    })
    assert.equal(await summarize(input), 'ok')
})

test('Jev batches Score questions with full protocol state and propagates usage', async () => {
    let calls = 0
    const provider = createJevJudge({
        apiKey: 'test-only',
        fetch: async (url, options) => {
            calls++
            assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
            const body = JSON.parse(String(options?.body))
            assert.equal(body.state.task, input.task)
            assert.deepEqual(body.state.messages, input.messages)
            assert.equal(Object.keys(body.questions).length, 3)
            assert.equal(body.questions.message_1.type, 'score')
            assert.match(body.questions.message_1.instructions, /state.messages\[1\]/)
            return Response.json({
                model: 'jev-test',
                answers: Object.fromEntries(
                    [0, 1, 2].map((index) => [
                        `message_${index}`,
                        { type: 'score', score: 3, confidence: 0.9 },
                    ]),
                ),
                usage: { input_tokens: 100, output_tokens: 20 },
            })
        },
    })
    const result = await provider(input)
    assert.equal(calls, 1)
    assert.equal(result.model, 'jev-test')
    assert.equal(result.inputTokens, 100)
    assert.equal(result.outputTokens, 20)
})

test('Jev missing key and oversized input do not make network calls', async () => {
    let calls = 0
    const fetcher: typeof fetch = async () => {
        calls++
        throw new Error('should not request')
    }
    await assert.rejects(createJevJudge({ fetch: fetcher })(input), /TYPESAFE_API_KEY/)
    await assert.rejects(
        createJevJudge({ apiKey: 'test', fetch: fetcher })({
            ...input,
            messages: Array.from({ length: 25 }, () => ({
                role: 'user' as const,
                content: 'message',
            })),
        }),
        /budget/,
    )
    assert.equal(calls, 0)
})

test('Jev HTTP errors omit response bodies and missing answers are rejected', async () => {
    await assert.rejects(
        createJevJudge({
            apiKey: 'test',
            fetch: async () => new Response('private details', { status: 401 }),
        })(input),
        (error: Error) => error.message === 'jev: HTTP 401',
    )
    await assert.rejects(
        createJevJudge({
            apiKey: 'test',
            fetch: async () => Response.json({ model: 'test', answers: {} }),
        })(input),
        /invalid Score/,
    )
})

test('Jev timeout falls back to a complete summary', async () => {
    const provider = createJevJudge({
        apiKey: 'test',
        timeoutMs: 10,
        fetch: async (_, options) => {
            await new Promise<void>((_, reject) => {
                const keepAlive = setTimeout(() => reject(new Error('test deadline')), 1000)
                options?.signal?.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(keepAlive)
                        reject(new Error('timeout'))
                    },
                    { once: true },
                )
            })
            throw new Error('unreachable')
        },
    })
    assert.equal(
        await createSemanticSummarizer({
            mode: 'assisted',
            judge: provider,
            summarize: async (draft) => {
                assert.equal(draft.messages, input.messages)
                return 'fallback'
            },
        })(input),
        'fallback',
    )
})

test('semantic summarizer failure leaves no checkpoint or completion event', async () => {
    const sessions = new SessionStore()
    const session = sessions.create()
    for (let index = 0; index < 5; index++) {
        sessions.append(session.id, 'user/message', { content: `constraint ${index}` })
        sessions.append(session.id, 'assistant/message', { content: 'response' })
    }
    const runtime = new CompactionRuntime({
        sessions,
        tokenMeter: { countMessages: () => 100 },
        options: { keepRecentEvents: 2 },
        summarizer: createSemanticSummarizer({
            mode: 'assisted',
            judge: async () => {
                throw new Error('unavailable')
            },
            summarize: async () => {
                throw new Error('summary also failed')
            },
        }),
    })
    assert.equal(await runtime.maybeCompact(session.id), false)
    assert.equal(session.events.filter((event) => event.type === 'compaction/start').length, 1)
    assert.equal(
        session.events.some((event) => event.type === 'compaction/end'),
        false,
    )
    assert.equal(
        session.events.some((event) => event.type === 'compaction/summary'),
        false,
    )
})

test('user cancellation during Jev judgment does not start the fallback summarizer', async () => {
    const controller = new AbortController()
    let summarized = false
    const summarize = createSemanticSummarizer({
        mode: 'assisted',
        judge: async () => {
            controller.abort()
            throw new Error('cancelled request')
        },
        summarize: async () => {
            summarized = true
            return 'must not run'
        },
    })
    await assert.rejects(summarize({ ...input, signal: controller.signal }), { name: 'AbortError' })
    assert.equal(summarized, false)
})

test('empty summary and cancellation during summarization never commit a checkpoint', async () => {
    for (const cancel of [false, true]) {
        const sessions = new SessionStore()
        const session = sessions.create()
        for (let index = 0; index < 5; index++) {
            sessions.append(session.id, 'user/message', { content: 'constraint' })
            sessions.append(session.id, 'assistant/message', { content: 'reply' })
        }
        const controller = new AbortController()
        const runtime = new CompactionRuntime({
            sessions,
            tokenMeter: { countMessages: () => 100 },
            options: { keepRecentEvents: 2 },
            summarizer: async () => {
                if (cancel) controller.abort()
                return cancel ? 'checkpoint produced after cancellation' : '   '
            },
        })
        if (cancel)
            await assert.rejects(runtime.maybeCompact(session.id, controller.signal), {
                name: 'AbortError',
            })
        else assert.equal(await runtime.maybeCompact(session.id), false)
        assert.equal(
            session.events.some((event) => event.type === 'compaction/end'),
            false,
        )
        assert.equal(
            session.events.some((event) => event.type === 'compaction/summary'),
            false,
        )
    }
})

test('plugin default summarizer passes tool metadata to LLM and records Jev failover', async () => {
    const ctx = new Context()
    await ctx.plugin(sessionsPlugin)
    await ctx.plugin(tokenMeter)
    await ctx.plugin(llmPlugin)
    await ctx.plugin(compaction, {
        semanticMode: 'assisted',
        keepRecentEvents: 2,
        model: 'mock/model',
        jev: {
            fetch: async () => {
                throw new Error('missing key must not call fetch')
            },
        },
    })
    let sawMetadata = false
    ctx.llm.register({
        name: 'mock',
        async *stream(request) {
            sawMetadata =
                (request.messages[0]?.content ?? '').includes('pnpm test') &&
                (request.messages[0]?.content ?? '').includes('tool_call_id')
            yield { type: 'content', text: 'pnpm test failed at line 42; do not upload.' }
        },
    })
    const session = ctx.sessions.create()
    ctx.sessions.append(session.id, 'user/message', { content: 'Do not upload.' })
    ctx.sessions.append(session.id, 'assistant/tool_calls', {
        toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'pnpm test' } }],
    })
    ctx.sessions.append(session.id, 'tool/result', {
        toolCallId: 'c1',
        content: 'Failure at line 42',
    })
    ctx.sessions.append(session.id, 'assistant/message', { content: 'Fix it next.' })
    ctx.sessions.append(session.id, 'user/message', { content: 'Continue fixing the test.' })
    ctx.sessions.append(session.id, 'assistant/message', { content: 'Will inspect the assertion.' })
    assert.equal(await ctx.compaction.maybeCompact(session.id), true)
    assert.equal(sawMetadata, true)
    assert.equal(ctx.compaction.lastObservation?.outcome, 'fallback')
    assert.equal(ctx.sessions.deriveMessages(session.id).length, 3)
})
