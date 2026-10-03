import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type TestContext, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { runSlashCommand } from '../src/cli/commands.ts'
import {
    decodeSessionFile,
    encodeEvent,
    encodeHeader,
    SESSION_FORMAT_VERSION,
} from '../src/core/persistence.ts'
import { Session, type SessionEvent, SessionStore } from '../src/core/session.ts'
import * as persistence from '../src/plugins/persistence.ts'
import * as sessions from '../src/plugins/sessions.ts'
import { JsonlPersistence } from '../src/providers/jsonl-persistence.ts'

// E1 验收：每 append 落一行；首行是 SessionHeader；半行不炸加载；CLI 命令可用。

async function makeDir(t: TestContext): Promise<string> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-dsh-persist-'))
    t.after(async () => {
        await fs.rm(base, { recursive: true, force: true })
    })
    return path.join(base, 'sessions')
}

function attach(store: SessionStore, provider: JsonlPersistence): void {
    store.observe({
        create: (session) => {
            void provider.saveHeader(session)
        },
        append: (session, event) => {
            void provider.appendEvent(session, event)
        },
    })
}

// ---------- 编解码 ----------

test('编解码往返：header 首行 + 事件逐行', () => {
    const header = { id: 's1', createdAt: '2026-01-01T00:00:00.000Z', title: 'demo' }
    const event: SessionEvent = {
        seq: 1,
        type: 'user/message',
        data: { content: 'hi' },
        at: '2026-01-01T00:00:01.000Z',
    }

    const decoded = decodeSessionFile(encodeHeader(header) + encodeEvent(event))
    assert.ok(decoded)
    assert.equal(decoded.header.id, 's1')
    assert.equal(decoded.header.version, SESSION_FORMAT_VERSION)
    assert.equal(decoded.header.title, 'demo')
    assert.deepEqual(decoded.events, [event])
    assert.equal(decoded.skipped, 0)
})

test('崩溃留下的半行 / 非法行被跳过，其余事件照常解出', () => {
    const lines = [
        JSON.stringify({
            type: 'session',
            version: SESSION_FORMAT_VERSION,
            id: 's1',
            createdAt: '2026-01-01T00:00:00.000Z',
        }),
        JSON.stringify({
            seq: 1,
            type: 'user/message',
            data: { content: 'hi' },
            at: '2026-01-01T00:00:01.000Z',
        }),
        '{"seq":2,"type":"assistant/mes', // 半行
        'not json at all',
        JSON.stringify({ seq: 'nope', type: 'x', at: 'y' }), // 形状不对
        JSON.stringify({
            seq: 3,
            type: 'assistant/message',
            data: { content: 'ok' },
            at: '2026-01-01T00:00:03.000Z',
        }),
    ]

    const decoded = decodeSessionFile(`${lines.join('\n')}\n`)
    assert.ok(decoded)
    assert.deepEqual(
        decoded.events.map((event) => event.seq),
        [1, 3],
    )
    assert.equal(decoded.skipped, 3)
})

test('没有合法 header 的文件解析为 undefined（加载方跳过即可）', () => {
    assert.equal(decodeSessionFile(''), undefined)
    assert.equal(decodeSessionFile('{"seq":1,"type":"x","at":"y"}\n'), undefined)
    assert.equal(decodeSessionFile('{"type":"session","id":123}\n'), undefined)
})

// ---------- provider + store ----------

test('每 append 一个事件就落一行，首行是 SessionHeader', async (t) => {
    const dir = await makeDir(t)
    const store = new SessionStore()
    const provider = new JsonlPersistence(dir)
    attach(store, provider)

    const session = store.create({ title: 'demo' })
    store.append(session.id, 'user/message', { content: 'hi' })
    store.append(session.id, 'assistant/message', { content: 'hello' })
    store.clear(session.id)
    await provider.flush()

    const lines = (await fs.readFile(provider.file(session.id), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 4)

    const header = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    assert.equal(header.type, 'session')
    assert.equal(header.version, SESSION_FORMAT_VERSION)
    assert.equal(header.id, session.id)
    assert.equal(header.createdAt, session.createdAt)
    assert.equal(header.title, 'demo')

    assert.equal((JSON.parse(lines[1] ?? '{}') as { type: string }).type, 'user/message')
    assert.equal((JSON.parse(lines[2] ?? '{}') as { type: string }).type, 'assistant/message')
    assert.equal((JSON.parse(lines[3] ?? '{}') as { type: string }).type, 'session/reset')
})

test('resume 恢复事件与 seq，恢复后继续 append 不会从头开始', async (t) => {
    const dir = await makeDir(t)
    const store = new SessionStore()
    const provider = new JsonlPersistence(dir)
    attach(store, provider)

    const session = store.create()
    store.append(session.id, 'user/message', { content: 'ping' })
    await provider.flush()

    const decoded = await provider.resume(session.id)
    assert.ok(decoded)

    const restored = new SessionStore()
    const adopted = restored.adopt(new Session(decoded.header, decoded.events))
    assert.equal(adopted.id, session.id)
    assert.deepEqual(restored.deriveMessages(session.id), [{ role: 'user', content: 'ping' }])

    const next = restored.append(session.id, 'assistant/message', { content: 'pong' })
    assert.equal(next.seq, 2)
})

test('崩溃留下的半行不影响 resume / list', async (t) => {
    const dir = await makeDir(t)
    const store = new SessionStore()
    const provider = new JsonlPersistence(dir)
    attach(store, provider)

    const session = store.create()
    store.append(session.id, 'user/message', { content: 'ping' })
    await provider.flush()
    // 模拟写到一半崩溃。
    await fs.appendFile(provider.file(session.id), '{"seq":9,"type":"user/mes', 'utf8')

    const fresh = new JsonlPersistence(dir)
    const decoded = await fresh.resume(session.id)
    assert.ok(decoded)
    assert.equal(decoded.events.length, 1)
    assert.equal(decoded.skipped, 1)

    const metas = await fresh.list()
    assert.equal(metas.length, 1)
    assert.equal(metas[0]?.id, session.id)
    assert.equal(metas[0]?.eventCount, 1)
})

test('delete 删除文件；非法 id 被拒', async (t) => {
    const dir = await makeDir(t)
    const store = new SessionStore()
    const provider = new JsonlPersistence(dir)
    attach(store, provider)

    const session = store.create()
    store.append(session.id, 'user/message', { content: 'x' })
    await provider.flush()

    assert.equal(await provider.delete(session.id), true)
    assert.equal(await provider.delete(session.id), false)
    assert.deepEqual(await provider.list(), [])

    await assert.rejects(provider.resume('../evil'), /invalid session id/)
    await assert.rejects(provider.delete('a/b'), /invalid session id/)
})

// ---------- 插件层 ----------

test('插件层：会话落盘，进程重启后 list / resume 可用', async (t) => {
    const dir = await makeDir(t)

    const first = new Context()
    await first.plugin(sessions)
    await first.plugin(persistence, { directory: dir })
    const session = first.sessions.create({ title: 'boot' })
    first.sessions.append(session.id, 'user/message', { content: 'ping' })
    first.sessions.append(session.id, 'assistant/message', { content: 'pong' })
    await first.persistence.flush()

    // 模拟进程重启：全新 Context 读同一目录。
    const second = new Context()
    await second.plugin(sessions)
    await second.plugin(persistence, { directory: dir })

    const metas = await second.persistence.list()
    assert.equal(metas.length, 1)
    assert.equal(metas[0]?.id, session.id)
    assert.equal(metas[0]?.eventCount, 2)

    const resumed = await second.persistence.resume(session.id)
    assert.ok(resumed)
    assert.deepEqual(second.sessions.deriveMessages(session.id), [
        { role: 'user', content: 'ping' },
        { role: 'assistant', content: 'pong' },
    ])

    assert.equal(await second.persistence.delete(session.id), true)
    assert.equal(second.sessions.get(session.id), undefined)
})

test('插件层：卸载 persistence 后 ctx.persistence 消失，sessions 照常工作', async (t) => {
    const dir = await makeDir(t)
    const ctx = new Context()
    await ctx.plugin(sessions)
    const fiber = ctx.plugin(persistence, { directory: dir })
    await fiber

    const session = ctx.sessions.create()
    ctx.sessions.append(session.id, 'user/message', { content: 'x' })
    await ctx.persistence.flush()

    await fiber.dispose()
    assert.equal(ctx.persistence, undefined)
    assert.equal(ctx.sessions.deriveMessages(session.id).length, 1)
})

// ---------- CLI 斜杠命令 ----------

test('斜杠命令：/help /clear /sessions /resume /delete /exit', async () => {
    const cleared: string[] = []
    const ports = {
        sessions: {
            create: () => ({ id: 'new' }),
            clear: (id: string) => {
                cleared.push(id)
            },
        },
        persistence: {
            list: async () => [{ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', eventCount: 2 }],
            resume: async (id: string) => (id === 'a' ? { id: 'a' } : undefined),
            delete: async (id: string) => id === 'a',
        },
    }

    assert.match(
        (await runSlashCommand('/help', ports, { sessionId: 's1' }))?.output ?? '',
        /\/resume/,
    )
    assert.equal(
        (await runSlashCommand('/clear', ports, { sessionId: 's1' }))?.output,
        'session cleared',
    )
    assert.deepEqual(cleared, ['s1'])
    assert.match(
        (await runSlashCommand('/sessions', ports, { sessionId: 's1' }))?.output ?? '',
        /a {2}2026-01-01/,
    )
    assert.equal((await runSlashCommand('/resume a', ports, { sessionId: 's1' }))?.sessionId, 'a')
    assert.match(
        (await runSlashCommand('/resume b', ports, { sessionId: 's1' }))?.output ?? '',
        /not found/,
    )
    assert.equal(
        (await runSlashCommand('/delete a', ports, { sessionId: 's1' }))?.output,
        'deleted a',
    )
    assert.match(
        (await runSlashCommand('/delete b', ports, { sessionId: 's1' }))?.output ?? '',
        /not found/,
    )
    assert.match(
        (await runSlashCommand('/resume', ports, { sessionId: 's1' }))?.output ?? '',
        /usage/,
    )
    assert.equal(await runSlashCommand('hello', ports, { sessionId: 's1' }), undefined)
    assert.equal((await runSlashCommand('/exit', ports, { sessionId: 's1' }))?.exit, true)
})

test('斜杠命令：persistence 未启用时给出提示而不是崩溃', async () => {
    const ports = { sessions: { create: () => ({ id: 'x' }), clear: () => {} } }
    for (const line of ['/sessions', '/resume a', '/delete a']) {
        assert.equal(
            (await runSlashCommand(line, ports, { sessionId: 's' }))?.output,
            'persistence is not enabled',
        )
    }
})
