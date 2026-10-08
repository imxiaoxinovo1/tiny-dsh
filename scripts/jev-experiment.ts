import fs from 'node:fs/promises'
import path from 'node:path'
import dotenv from 'dotenv'
import type { SummarizeInput } from '../src/core/compaction.ts'
import { LlmRuntime } from '../src/core/llm.ts'
import {
    createSemanticSummarizer,
    type SemanticObservation,
    SUMMARY_SYSTEM,
    type SummaryInput,
    summaryPrompt,
} from '../src/core/semantic-compaction.ts'
import { estimateMessages, estimateTokens } from '../src/core/token.ts'
import { createDeepSeekProvider } from '../src/providers/deepseek.ts'
import { createJevJudge } from '../src/providers/jev.ts'
import { experimentCases } from './fixtures/jev-cases.ts'

dotenv.config({ quiet: true })
const live = process.argv.includes('--live')
const requested = Number(process.env.TINY_DSH_EXPERIMENT_REPEATS ?? '1')
if (!Number.isInteger(requested) || requested < 1 || requested > 3)
    throw new Error('repeats must be 1..3')
const llm = new LlmRuntime()
const model = process.env.TINY_DSH_MODEL ?? 'deepseek/deepseek-v4-flash'
if (live && (!process.env.DEEPSEEK_API_KEY || !process.env.TYPESAFE_API_KEY)) {
    console.error(
        'Live comparison requires DEEPSEEK_API_KEY and TYPESAFE_API_KEY in this repository .env.',
    )
    process.exitCode = 1
} else {
    llm.register(
        createDeepSeekProvider({
            apiKey: process.env.DEEPSEEK_API_KEY,
            baseUrl: process.env.DEEPSEEK_BASE_URL,
        }),
    )
    const rows: Record<string, unknown>[] = []
    const dataset = JSON.stringify(experimentCases)
    const { createHash } = await import('node:crypto')
    const datasetHash = createHash('sha256').update(dataset).digest('hex')
    console.log(`${live ? 'LIVE' : 'OFFLINE HARNESS'} · 6 synthetic cases · ${requested} repeat(s)`)
    for (let repeat = 0; repeat < requested; repeat++) {
        for (const sample of experimentCases) {
            const input: SummarizeInput = {
                sessionId: sample.id,
                start: 1,
                end: sample.messages.length,
                messages: sample.messages,
                task: sample.task,
            }
            let observation: SemanticObservation | undefined
            const summarize = async (draft: SummaryInput): Promise<string> => {
                if (!live) return sample.facts.join('; ') // Oracle stub: plumbing check, not model quality.
                return (
                    await llm.complete({
                        model,
                        system: `${SUMMARY_SYSTEM}\nUse at most 120 words.`,
                        messages: [{ role: 'user', content: summaryPrompt(draft) }],
                        signal: AbortSignal.timeout(45000),
                    })
                ).content
            }
            const assisted = createSemanticSummarizer({
                mode: 'assisted',
                judge: live
                    ? createJevJudge({
                          apiKey: process.env.TYPESAFE_API_KEY,
                          model: process.env.TINY_DSH_JEV_MODEL,
                          timeoutMs: 15000,
                      })
                    : async () => ({
                          model: 'oracle-stub',
                          items: sample.messages.map((_, index) => ({
                              index,
                              score: sample.important.includes(index) ? 3 : 0,
                              confidence: 1,
                          })),
                      }),
                summarize,
                observe: (value) => {
                    observation = value
                },
            })
            for (const arm of ['legacy', 'full-transcript', 'jev-assisted'] as const) {
                const started = performance.now()
                observation = undefined
                try {
                    const summary =
                        arm === 'jev-assisted'
                            ? await assisted(input)
                            : arm === 'full-transcript'
                              ? await summarize(input)
                              : live
                                ? (
                                      await llm.complete({
                                          model,
                                          system:
                                              'You compress an agent conversation into a durable checkpoint.\n' +
                                              'Keep concrete facts: file paths, commands, decisions, unresolved questions, and the current plan.\n' +
                                              'Drop pleasantries and repetition. Reply with the summary only.\nUse at most 120 words.',
                                          messages: [
                                              {
                                                  role: 'user',
                                                  content:
                                                      'Summarize this conversation segment:\n' +
                                                      sample.messages
                                                          .map(
                                                              (message) =>
                                                                  message.role +
                                                                  ': ' +
                                                                  (message.content ?? ''),
                                                          )
                                                          .join('\n'),
                                              },
                                          ],
                                          signal: AbortSignal.timeout(45000),
                                      })
                                  ).content
                                : sample.facts.join('; ')
                    const summaryMs = performance.now() - started
                    const probeStarted = performance.now()
                    const answer = live
                        ? (
                              await llm.complete({
                                  model,
                                  system: 'Answer using only the checkpoint. If a value is missing, say UNKNOWN. Be concise.',
                                  messages: [
                                      {
                                          role: 'user',
                                          content:
                                              'Checkpoint:\n' +
                                              summary +
                                              '\n\nQuestion:\n' +
                                              sample.probe,
                                      },
                                  ],
                                  signal: AbortSignal.timeout(45000),
                              })
                          ).content
                        : sample.expected.join('; ')
                    const matched = sample.facts.filter((fact) =>
                        summary.toLowerCase().includes(fact.toLowerCase()),
                    ).length
                    const probeMatched = sample.expected.filter((fact) =>
                        answer.toLowerCase().includes(fact.toLowerCase()),
                    ).length
                    // This is lexical recall, not an entailment or successful task-execution metric.
                    rows.push({
                        case: sample.id,
                        repeat,
                        arm,
                        summary,
                        answer,
                        factHits: matched,
                        factTotal: sample.facts.length,
                        probeHits: probeMatched,
                        probeTotal: sample.expected.length,
                        sourceTokens: estimateMessages(sample.messages),
                        summaryTokens: estimateTokens(summary),
                        summaryMs,
                        probeMs: performance.now() - probeStarted,
                        observation,
                    })
                    console.log(
                        sample.id +
                            ' / ' +
                            arm +
                            ' · facts ' +
                            matched +
                            '/' +
                            sample.facts.length +
                            ' · probe ' +
                            probeMatched +
                            '/' +
                            sample.expected.length +
                            ' · ' +
                            Math.round(summaryMs) +
                            'ms' +
                            ((observation as SemanticObservation | undefined)?.outcome ===
                            'fallback'
                                ? ' · FALLBACK'
                                : ''),
                    )
                } catch (error) {
                    const raw = error instanceof Error ? error.message : String(error)
                    const status = raw.match(/HTTP \d+/)?.[0]
                    rows.push({
                        case: sample.id,
                        repeat,
                        arm,
                        error: status ?? 'request failed or timed out',
                    })
                    console.log(`${sample.id} / ${arm} · failed`)
                }
            }
        }
    }
    const directory = path.resolve(`.tmp/jev-experiment-${live ? 'live' : 'offline'}`)
    await fs.mkdir(directory, { recursive: true })
    const manifest = {
        live,
        datasetHash,
        model: live ? model : 'oracle-stub',
        jevModel: live ? (process.env.TINY_DSH_JEV_MODEL ?? 'jev-latest') : 'oracle-stub',
        repeats: requested,
        cases: experimentCases.length,
        timestamp: new Date().toISOString(),
        policy: { score: 2, confidence: 0.6, topK: 4 },
        maxDeepSeekCalls: experimentCases.length * requested * 6,
        maxJevCalls: experimentCases.length * requested,
    }
    await fs.writeFile(
        path.join(directory, 'results.json'),
        JSON.stringify({ manifest, rows }, null, 2),
    )
    const lines = [
        '# Jev compaction experiment',
        '',
        live
            ? 'Live synthetic pilot; not production evidence.'
            : 'Oracle stubs only. These numbers validate plumbing and must not be reported as model accuracy.',
        '',
        '| Arm | Completed | Fact recall | Probe recall | Mean summary ms | Mean token ratio | Jev fallbacks |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ]
    for (const arm of ['legacy', 'full-transcript', 'jev-assisted']) {
        const successful = rows.filter((row) => row.arm === arm && !row.error)
        const sum = (key: string) => successful.reduce((total, row) => total + Number(row[key]), 0)
        const ratio = successful.reduce(
            (total, row) => total + Number(row.summaryTokens) / Number(row.sourceTokens),
            0,
        )
        lines.push(
            '| ' +
                arm +
                ' | ' +
                successful.length +
                '/' +
                experimentCases.length * requested +
                ' | ' +
                sum('factHits') +
                '/' +
                sum('factTotal') +
                ' | ' +
                sum('probeHits') +
                '/' +
                sum('probeTotal') +
                ' | ' +
                Math.round(sum('summaryMs') / (successful.length || 1)) +
                ' | ' +
                (ratio / (successful.length || 1)).toFixed(3) +
                ' | ' +
                successful.filter(
                    (row) =>
                        (row.observation as SemanticObservation | undefined)?.outcome ===
                        'fallback',
                ).length +
                ' |',
        )
    }
    lines.push(
        '',
        'Fact/probe recall uses case-insensitive exact substrings and needs manual review.',
        'Input/output usage is recorded for Jev when available; DeepSeek total usage/cost is not measured.',
        'Protocol safety and failover are covered separately by deterministic tests.',
        'Promotion requires repeated holdout evidence; keep Jev off by default after this pilot.',
    )
    await fs.writeFile(path.join(directory, 'report.md'), `${lines.join('\n')}\n`)
    console.log(`Saved ${directory}`)
    if (rows.some((row) => row.error)) process.exitCode = 1
}
