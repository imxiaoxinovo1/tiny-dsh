import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type TestContext, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { runSlashCommand } from '../src/cli/commands.ts'
import {
    CUSTOM_PRESET,
    DEFAULT_PRESETS,
    derivePreset,
    presetTable,
    resolvePreset,
} from '../src/core/permission-preset.ts'
import type { ToolExecutionContext } from '../src/core/tool.ts'
import * as approval from '../src/plugins/approval.ts'
import * as permissionPresets from '../src/plugins/permission-presets.ts'
import * as sandbox from '../src/plugins/sandbox.ts'
import * as sessions from '../src/plugins/sessions.ts'
import * as tools from '../src/plugins/tools.ts'
import * as files from '../src/tools/files.ts'

// E3 验收：workspace-write = workspace-write + ask；danger-full-access = danger-full-access + never；
// 任一旋钮被单独改动后当前预设降级为派生的 custom。

async function makeWorkspace(t: TestContext): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-dsh-perm-'))
    t.after(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })
    return root
}

// ---------- 纯逻辑 ----------

test('derivePreset：两个旋钮 → 预设名，匹配不到就是 custom', () => {
    assert.equal(derivePreset('workspace-write', 'ask'), 'workspace-write')
    assert.equal(derivePreset('danger-full-access', 'never'), 'danger-full-access')
    // 单独改动任一旋钮 → 不再匹配任何预设
    assert.equal(derivePreset('workspace-write', 'never'), CUSTOM_PRESET)
    assert.equal(derivePreset('danger-full-access', 'ask'), CUSTOM_PRESET)
    assert.equal(derivePreset('read-only', 'ask'), CUSTOM_PRESET)
})

test('resolvePreset：未知名字与 custom 都抛可读错误', () => {
    assert.equal(resolvePreset('workspace-write').sandbox, 'workspace-write')
    assert.equal(resolvePreset('danger-full-access').approval, 'never')
    assert.throws(() => resolvePreset('nope'), /unknown permission preset: "nope"/)
    assert.throws(() => resolvePreset(CUSTOM_PRESET), /derived-only/)
})

test('默认表只发两个预设，bundle 与 DSH 一致', () => {
    const table = presetTable()
    assert.deepEqual(Object.keys(table), ['workspace-write', 'danger-full-access'])
    assert.deepEqual(DEFAULT_PRESETS[0], {
        name: 'workspace-write',
        sandbox: 'workspace-write',
        approval: 'ask',
        description: 'Read and write inside the workspace; ask before writes.',
    })
    assert.deepEqual(DEFAULT_PRESETS[1], {
        name: 'danger-full-access',
        sandbox: 'danger-full-access',
        approval: 'never',
        description: 'No workspace confinement, no approval prompts.',
    })
})

// ---------- 插件层 ----------

test('select 一次写两个旋钮；单独改旋钮降级为 custom', async (t) => {
    const root = await makeWorkspace(t)
    const ctx = new Context()
    await ctx.plugin(sandbox, { workspace: root })
    await ctx.plugin(approval)
    await ctx.plugin(permissionPresets, { defaultPreset: 'workspace-write' })

    assert.equal(ctx.permissionPresets.current(), 'workspace-write')
    assert.equal(ctx.sandbox.mode, 'workspace-write')
    assert.equal(ctx.approval.policy, 'ask')

    ctx.permissionPresets.select('danger-full-access')
    assert.equal(ctx.permissionPresets.current(), 'danger-full-access')
    assert.equal(ctx.sandbox.mode, 'danger-full-access')
    assert.equal(ctx.approval.policy, 'never')

    // 单独把审批策略改回 ask → danger-full-access + ask 不匹配任何预设
    ctx.permissionPresets.setPolicy('ask')
    assert.equal(ctx.permissionPresets.current(), CUSTOM_PRESET)

    ctx.permissionPresets.select('workspace-write')
    assert.equal(ctx.permissionPresets.current(), 'workspace-write')

    // 单独把 sandbox 改成 read-only → read-only + ask 同样不匹配
    ctx.permissionPresets.setMode('read-only')
    assert.equal(ctx.permissionPresets.current(), CUSTOM_PRESET)
    assert.equal(ctx.sandbox.mode, 'read-only')
})

test('保留名不能作为可配置预设', async (t) => {
    const root = await makeWorkspace(t)
    const ctx = new Context()
    await ctx.plugin(sandbox, { workspace: root })
    await ctx.plugin(approval)

    await assert.rejects(async () => {
        await ctx.plugin(permissionPresets, {
            presets: [{ name: 'custom', sandbox: 'workspace-write', approval: 'ask' }],
        })
    }, /is reserved/)
})

test('审批策略：never 不询问任何人直接拒绝；ask 走回答者，无回答者 fail closed', async () => {
    const ctx = new Context()
    await ctx.plugin(approval)

    ctx.approval.setAnswerer(() => true)
    assert.equal(await ctx.approval.request({ tool: 'x', reason: 'y' }), 'allow')

    ctx.approval.setPolicy('never')
    assert.equal(await ctx.approval.request({ tool: 'x', reason: 'y' }), 'deny')

    ctx.approval.setPolicy('ask')
    ctx.approval.setAnswerer(() => false)
    assert.equal(await ctx.approval.request({ tool: 'x', reason: 'y' }), 'deny')
})

// ---------- 与工具的集成 ----------

test('danger-full-access 下不需要审批；切回 workspace-write 后写操作被拒', async (t) => {
    const root = await makeWorkspace(t)
    const ctx = new Context()
    await ctx.plugin(sessions)
    await ctx.plugin(tools)
    await ctx.plugin(approval)
    await ctx.plugin(sandbox, { workspace: root })
    await ctx.plugin(permissionPresets, { defaultPreset: 'danger-full-access' })
    await ctx.plugin(files)

    const context = (): ToolExecutionContext => ({
        sessionId: 's1',
        sandbox: ctx.sandbox,
        approval: ctx.approval,
    })

    // full-access：沙箱放行、审批不触发，所以没有回答者也写得进去。
    const allowed = await ctx.tools.execute(
        { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'hi' } },
        context(),
    )
    assert.equal(allowed.isError, false)
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'hi')

    // 切回 workspace-write 且没有回答者 → fail closed。
    ctx.permissionPresets.select('workspace-write')
    const denied = await ctx.tools.execute(
        { id: 'c2', name: 'write_file', arguments: { path: 'b.txt', content: 'nope' } },
        context(),
    )
    assert.equal(denied.isError, true)
    assert.match(denied.content, /denied by approval/)
})

// ---------- CLI ----------

test('斜杠命令 /permissions 与 /permission <name>', async () => {
    let selected = 'workspace-write'
    const ports = {
        sessions: { create: () => ({ id: 's' }), clear: () => {} },
        permissionPresets: {
            current: () => selected,
            list: () => [
                { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
                { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
            ],
            select: (name: string) => {
                if (name !== 'workspace-write' && name !== 'danger-full-access') {
                    throw new Error(`unknown permission preset: "${name}"`)
                }
                selected = name
            },
        },
    }

    const listed = await runSlashCommand('/permissions', ports, { sessionId: 's' })
    assert.match(listed?.output ?? '', /current: workspace-write/)
    assert.match(listed?.output ?? '', /\* workspace-write/)
    assert.match(listed?.output ?? '', /danger-full-access/)

    const switched = await runSlashCommand('/permission danger-full-access', ports, {
        sessionId: 's',
    })
    assert.equal(switched?.output, 'permission -> danger-full-access')

    const unknown = await runSlashCommand('/permission nope', ports, { sessionId: 's' })
    assert.match(unknown?.output ?? '', /unknown permission preset/)

    const usage = await runSlashCommand('/permission', ports, { sessionId: 's' })
    assert.match(usage?.output ?? '', /usage/)

    const disabled = await runSlashCommand(
        '/permissions',
        { sessions: ports.sessions },
        { sessionId: 's' },
    )
    assert.equal(disabled?.output, 'permission presets are not enabled')
})
