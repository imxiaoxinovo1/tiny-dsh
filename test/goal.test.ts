import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type TestContext, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { goalContinuationPrompt, runSlashCommand } from '../src/cli/commands.ts'
import { DEFAULT_MAX_GOAL_ROUNDS, GoalError, GoalRuntime } from '../src/core/goal.ts'
import * as goal from '../src/plugins/goal.ts'
import * as persistence from '../src/plugins/persistence.ts'
import * as sessions from '../src/plugins/sessions.ts'

// E4 验收：四个阶段；Round 上限后不再自动续行；/continue 开新 Round 并生成一个轮次。

async function makeDir(t: TestContext): Promise<string> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-dsh-goal-'))
    t.after(async () => {
        await fs.rm(base, { recursive: true, force: true })
    })
    return path.join(base, 'sessions')
}

// ---------- 状态机 ----------

test('四个阶段与合法迁移', () => {
    const runtime = new GoalRuntime()
    const goal = runtime.set('s1', 'ship E4')
    assert.equal(goal.phase, 'active')
    assert.equal(goal.maxGoalRounds, DEFAULT_MAX_GOAL_ROUNDS)
    assert.equal(goal.roundsStarted, 0)

    assert.equal(runtime.pause(goal.id).phase, 'paused')
    assert.throws(() => runtime.pause(goal.id), /cannot move to paused/)
    assert.equal(runtime.resume(goal.id).phase, 'active')
    assert.throws(() => runtime.resume(goal.id), /cannot move to active/)

    const blocked = runtime.block(goal.id, { code: 'needs-input', message: 'need a decision' })
    assert.equal(blocked.phase, 'blocked')
    assert.deepEqual(blocked.blockedReason, { code: 'needs-input', message: 'need a decision' })

    const resumed = runtime.resume(goal.id)
    assert.equal(resumed.phase, 'active')
    assert.equal(resumed.blockedReason, undefined)

    assert.equal(runtime.complete(goal.id).phase, 'complete')
    assert.throws(() => runtime.complete(goal.id), /cannot move to complete/)
    assert.throws(() => runtime.block(goal.id, { code: 'x', message: 'y' }), /cannot block/)
})

test('set 校验与时钟注入', () => {
    let clock = 1000
    const runtime = new GoalRuntime({ now: () => clock++ })
    assert.throws(() => runtime.set('s1', '   '), /objective is required/)
    assert.throws(() => runtime.set('', 'x'), /sessionId is required/)

    const goal = runtime.set('s1', 'obj')
    assert.equal(goal.createdAt, 1000)
    assert.equal(runtime.pause(goal.id).updatedAt, 1001)

    const other = runtime.set('s2', 'other obj')
    assert.equal(runtime.forSession('s1')?.id, goal.id)
    assert.equal(runtime.forSession('s2')?.id, other.id)
    assert.equal(runtime.forSession('missing'), undefined)
})

test('Round 上限：自动续行到上限为止，显式续行抛可读错误', () => {
    const runtime = new GoalRuntime()
    const goal = runtime.set('s1', 'obj', { maxGoalRounds: 2 })

    assert.equal(runtime.nextRound(goal.id), 1)
    assert.equal(runtime.nextRound(goal.id), 2)
    // 达到上限 → 不再自动续行
    assert.equal(runtime.nextRound(goal.id), undefined)
    assert.equal(runtime.canContinue(goal.id), false)
    assert.throws(() => runtime.continueRound(goal.id), /round limit reached \(2\/2\)/)

    // 非 active 也不能续行
    const runtime2 = new GoalRuntime()
    const paused = runtime2.set('s1', 'obj')
    runtime2.pause(paused.id)
    assert.equal(runtime2.nextRound(paused.id), undefined)
    assert.throws(() => runtime2.continueRound(paused.id), /goal is paused/)
})

// ---------- 插件层 ----------

test('ctx.goal：每次变更落一条 goal/change 事件，current/list 可用', async () => {
    const ctx = new Context()
    await ctx.plugin(sessions)
    await ctx.plugin(goal, { maxGoalRounds: 2 })
    const session = ctx.sessions.create()

    const created = ctx.goal.set(session.id, 'ship E4')
    assert.equal(ctx.goal.current(session.id)?.id, created.id)
    assert.equal(ctx.goal.list().length, 1)

    ctx.goal.pause(created.id)
    ctx.goal.resume(created.id)
    assert.equal(ctx.goal.continueRound(created.id), 1)
    assert.equal(ctx.goal.canContinue(created.id), true)
    assert.equal(ctx.goal.nextRound(created.id), 2)
    assert.equal(ctx.goal.nextRound(created.id), undefined)
    ctx.goal.complete(created.id)

    const events = session.events.filter((event) => event.type === 'goal/change')
    assert.deepEqual(
        events.map((event) => (event.data as { operation: string }).operation),
        ['set', 'pause', 'resume', 'continue', 'continue', 'complete'],
    )
    assert.equal(ctx.goal.current(session.id)?.phase, 'complete')
    assert.equal(ctx.goal.current(session.id)?.roundsStarted, 2)
})

test('目标是持久的：写进 JSONL，重开进程后可恢复', async (t) => {
    const dir = await makeDir(t)

    const first = new Context()
    await first.plugin(sessions)
    await first.plugin(goal, { maxGoalRounds: 2 })
    await first.plugin(persistence, { directory: dir })
    const session = first.sessions.create()
    const created = first.goal.set(session.id, 'ship E4')
    first.goal.continueRound(created.id)
    first.goal.pause(created.id)
    await first.persistence.flush()

    // 模拟进程重启。
    const second = new Context()
    await second.plugin(sessions)
    await second.plugin(goal, { maxGoalRounds: 2 })
    await second.plugin(persistence, { directory: dir })
    assert.ok(await second.persistence.resume(session.id))

    const restored = second.goal.restore(session.id)
    assert.ok(restored)
    assert.equal(restored.id, created.id)
    assert.equal(restored.objective, 'ship E4')
    assert.equal(restored.phase, 'paused')
    assert.equal(restored.roundsStarted, 1)
})

// ---------- CLI ----------

interface FakeGoal {
    id: string
    objective: string
    phase: string
    roundsStarted: number
    maxGoalRounds: number
    blockedReason?: { code: string; message: string }
}

function goalPorts(maxGoalRounds = 2) {
    let current: FakeGoal | undefined
    return {
        sessions: { create: () => ({ id: 's' }), clear: () => {} },
        goal: {
            current: () => current,
            set: (_sessionId: string, objective: string) => {
                current = { id: 'g1', objective, phase: 'active', roundsStarted: 0, maxGoalRounds }
                return current
            },
            pause: () => {
                if (current) current.phase = 'paused'
            },
            resume: () => {
                if (current) current.phase = 'active'
            },
            complete: () => {
                if (current) current.phase = 'complete'
            },
            block: (_id: string, reason: { code: string; message: string }) => {
                if (current) {
                    current.phase = 'blocked'
                    current.blockedReason = reason
                }
            },
            continueRound: () => {
                if (!current) throw new Error('no goal')
                if (current.phase !== 'active') {
                    throw new Error(`goal is ${current.phase}; cannot start a round`)
                }
                if (current.roundsStarted >= current.maxGoalRounds) {
                    throw new Error(
                        `goal round limit reached (${current.roundsStarted}/${current.maxGoalRounds})`,
                    )
                }
                current.roundsStarted += 1
                return current.roundsStarted
            },
        },
    }
}

test('斜杠命令：/goal 的 set / show / pause / resume / block / complete', async () => {
    const ports = goalPorts(2)
    const state = { sessionId: 's' }

    assert.equal((await runSlashCommand('/goal', ports, state))?.output, 'no goal for this session')
    assert.match(
        (await runSlashCommand('/goal ship E4 carefully', ports, state))?.output ?? '',
        /goal set: ship E4 carefully \(max 2 rounds\)/,
    )

    const shown = await runSlashCommand('/goal', ports, state)
    assert.match(shown?.output ?? '', /phase: active/)
    assert.match(shown?.output ?? '', /rounds: 0\/2/)
    assert.match(shown?.output ?? '', /objective: ship E4 carefully/)

    assert.equal((await runSlashCommand('/goal pause', ports, state))?.output, 'goal -> paused')
    assert.equal((await runSlashCommand('/goal resume', ports, state))?.output, 'goal -> active')
    assert.equal(
        (await runSlashCommand('/goal block waiting on review', ports, state))?.output,
        'goal -> blocked',
    )
    assert.match(
        (await runSlashCommand('/goal', ports, state))?.output ?? '',
        /blocked: user-blocked - waiting on review/,
    )
    assert.equal(
        (await runSlashCommand('/goal complete', ports, state))?.output,
        'goal -> complete',
    )
})

test('斜杠命令：/continue 开新 Round，达到上限后拒绝', async () => {
    const ports = goalPorts(2)
    const state = { sessionId: 's' }

    const noGoal = await runSlashCommand('/continue', ports, state)
    assert.match(noGoal?.output ?? '', /no goal for this session/)

    await runSlashCommand('/goal ship E4', ports, state)

    const first = await runSlashCommand('/continue', ports, state)
    assert.equal(first?.output, 'round 1/2 started')
    assert.equal(first?.run, 'Continue working toward the goal: ship E4 (round 1/2).')

    const second = await runSlashCommand('/continue', ports, state)
    assert.equal(second?.output, 'round 2/2 started')

    const capped = await runSlashCommand('/continue', ports, state)
    assert.match(capped?.output ?? '', /round limit reached \(2\/2\)/)
    assert.equal(capped?.run, undefined)

    // 暂停后也不能续行。
    await runSlashCommand('/goal pause', ports, state)
    const paused = await runSlashCommand('/continue', ports, state)
    assert.match(paused?.output ?? '', /goal is paused/)
})

test('斜杠命令：goal 未启用时给出提示', async () => {
    const ports = { sessions: { create: () => ({ id: 's' }), clear: () => {} } }
    assert.equal(
        (await runSlashCommand('/goal', ports, { sessionId: 's' }))?.output,
        'goals are not enabled',
    )
    assert.equal(
        (await runSlashCommand('/continue', ports, { sessionId: 's' }))?.output,
        'goals are not enabled',
    )
})

test('goalContinuationPrompt 带上目标与轮次', () => {
    assert.equal(
        goalContinuationPrompt({ objective: 'ship E4', maxGoalRounds: 3 }, 2),
        'Continue working toward the goal: ship E4 (round 2/3).',
    )
})

test('GoalError 有可读的 name', () => {
    const error = new GoalError('boom')
    assert.equal(error.name, 'GoalError')
    assert.equal(error.message, 'boom')
})
