import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import dotenv from 'dotenv'
import { isPairedRange } from '../src/core/compaction.ts'
import * as compaction from '../src/plugins/compaction.ts'
import * as llm from '../src/plugins/llm.ts'
import * as sessions from '../src/plugins/sessions.ts'
import * as tokenMeter from '../src/plugins/token-meter.ts'
import * as deepseek from '../src/providers/deepseek.ts'
import { experimentCases } from './fixtures/jev-cases.ts'

dotenv.config({ quiet: true })
if (!process.env.DEEPSEEK_API_KEY || !process.env.TYPESAFE_API_KEY) {
    throw new Error('Smoke test requires both API keys in .env')
}
const ctx = new Context()
await ctx.plugin(sessions)
await ctx.plugin(tokenMeter)
await ctx.plugin(llm)
await ctx.plugin(deepseek, {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
})
await ctx.plugin(compaction, {
    semanticMode: 'assisted',
    maxTokens: 10,
    keepRecentEvents: 2,
    model: process.env.TINY_DSH_MODEL,
    jev: {
        apiKey: process.env.TYPESAFE_API_KEY,
        model: process.env.TINY_DSH_JEV_MODEL,
        timeoutMs: 15000,
    },
})
const sample = experimentCases[1]
assert.ok(sample)
const session = ctx.sessions.create({ title: 'synthetic-jev-smoke' })
for (const message of sample.messages) {
    if (message.tool_calls) {
        ctx.sessions.append(session.id, 'assistant/tool_calls', {
            content: message.content,
            toolCalls: message.tool_calls.map((call) => ({
                id: call.id,
                name: call.function.name,
                arguments: JSON.parse(call.function.arguments),
            })),
        })
    } else if (message.role === 'tool') {
        ctx.sessions.append(session.id, 'tool/result', {
            toolCallId: message.tool_call_id,
            content: message.content,
        })
    } else {
        ctx.sessions.append(session.id, `${message.role}/message`, { content: message.content })
    }
}
ctx.sessions.append(session.id, 'user/message', { content: sample.task })
ctx.sessions.append(session.id, 'assistant/message', {
    content: 'Next: fix the failing assertion.',
})
const original = structuredClone(session.events)
const messages = await ctx.compaction.prepare(session.id, AbortSignal.timeout(45000))
assert.deepEqual(session.events.slice(0, original.length), original)
assert.equal(isPairedRange(original), true)
assert.equal(session.events.filter((event) => event.type === 'compaction/end').length, 1)
assert.equal(messages.length, 3)
assert.match(messages[0]?.content ?? '', /test\/permissions\.test\.ts/)
assert.notEqual(ctx.compaction.lastObservation?.outcome, 'fallback')
console.log(
    JSON.stringify(
        {
            checkpoint: true,
            originalEventsPreserved: true,
            toolPairsPreserved: true,
            projectedMessages: messages.length,
            observation: ctx.compaction.lastObservation,
        },
        null,
        4,
    ),
)
