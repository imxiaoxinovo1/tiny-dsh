import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type TestContext, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createApprovalAnswerer } from '../src/cli/answerer.ts'
import type { SandboxMode, ToolExecutionContext, ToolResult } from '../src/core/tool.ts'
import * as approval from '../src/plugins/approval.ts'
import * as sandbox from '../src/plugins/sandbox.ts'
import * as sessions from '../src/plugins/sessions.ts'
import * as tools from '../src/plugins/tools.ts'
import * as files from '../src/tools/files.ts'
import * as search from '../src/tools/search.ts'
import type { CommandOptions, CommandRunner } from '../src/tools/shell.ts'
import * as shell from '../src/tools/shell.ts'

// D7 验收：写操作没有审批通道时 fail closed；命令超时与输出截断生效；
// 文件工具过路径闸门。所有文件操作都在一个临时 workspace 里。

async function makeWorkspace(t: TestContext): Promise<{ root: string; outside: string }> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-dsh-tools-'))
    const root = path.join(base, 'workspace')
    const outside = path.join(base, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8')
    t.after(async () => {
        await fs.rm(base, { recursive: true, force: true })
    })
    return { root, outside }
}

interface StackOptions {
    workspace: string
    mode?: SandboxMode
    withApproval?: boolean
    runner?: CommandRunner
    timeoutMs?: number
    maxOutputChars?: number
}

async function makeStack(options: StackOptions): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(sessions)
    await ctx.plugin(tools)
    if (options.withApproval !== false) await ctx.plugin(approval)
    await ctx.plugin(sandbox, { workspace: options.workspace, mode: options.mode })
    await ctx.plugin(files)
    await ctx.plugin(search)
    await ctx.plugin(shell, {
        runner: options.runner,
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars,
    })
    return ctx
}

function contextFor(ctx: Context, withApproval = true): ToolExecutionContext {
    return {
        sessionId: 's1',
        sandbox: ctx.sandbox,
        ...(withApproval ? { approval: ctx.approval } : {}),
    }
}

async function callTool(
    ctx: Context,
    name: string,
    args: unknown,
    context: ToolExecutionContext,
): Promise<ToolResult> {
    return ctx.tools.execute({ id: 'call-1', name, arguments: args }, context)
}

const okRunner: CommandRunner = async () => ({
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
})

const timedOutRunner: CommandRunner = async () => ({
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: true,
    truncated: false,
})

const chattyRunner: CommandRunner = async (_command, options) => ({
    stdout: 'x'.repeat(options.maxOutputChars * 2),
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
})

test('read-only 模式下写操作被 sandbox 拒绝', async (t) => {
    const { root } = await makeWorkspace(t)
    const ctx = await makeStack({ workspace: root, mode: 'read-only' })

    const result = await callTool(
        ctx,
        'write_file',
        { path: 'a.txt', content: 'x' },
        contextFor(ctx),
    )

    assert.equal(result.isError, true)
    assert.match(result.content, /read-only/)
})

test('没有审批通道时写操作 fail closed，文件不会被创建', async (t) => {
    const { root } = await makeWorkspace(t)
    const ctx = await makeStack({ workspace: root, withApproval: false })

    const result = await callTool(
        ctx,
        'write_file',
        { path: 'a.txt', content: 'x' },
        contextFor(ctx, false),
    )

    assert.equal(result.isError, true)
    assert.match(result.content, /approval required/)
    await assert.rejects(fs.stat(path.join(root, 'a.txt')))
})

test('审批通过后 write_file / read_file / edit_file 正常往返', async (t) => {
    const { root } = await makeWorkspace(t)
    const ctx = await makeStack({ workspace: root })
    ctx.approval.setAnswerer(() => true)

    const written = await callTool(
        ctx,
        'write_file',
        { path: 'src/a.txt', content: 'hello' },
        contextFor(ctx),
    )
    assert.equal(written.isError, false)

    const read = await callTool(ctx, 'read_file', { path: 'src/a.txt' }, contextFor(ctx))
    assert.equal(read.content, 'hello')

    const edited = await callTool(
        ctx,
        'edit_file',
        { path: 'src/a.txt', old_string: 'hello', new_string: 'world' },
        contextFor(ctx),
    )
    assert.equal(edited.isError, false)
    assert.equal(
        (await callTool(ctx, 'read_file', { path: 'src/a.txt' }, contextFor(ctx))).content,
        'world',
    )

    const missing = await callTool(
        ctx,
        'edit_file',
        { path: 'src/a.txt', old_string: 'nope', new_string: 'x' },
        contextFor(ctx),
    )
    assert.equal(missing.isError, true)
    assert.match(missing.content, /old_string not found/)
})

test('审批被拒绝时写操作失败，文件不会被创建', async (t) => {
    const { root } = await makeWorkspace(t)
    const ctx = await makeStack({ workspace: root })
    ctx.approval.setAnswerer(() => false)

    const result = await callTool(
        ctx,
        'write_file',
        { path: 'a.txt', content: 'x' },
        contextFor(ctx),
    )

    assert.equal(result.isError, true)
    assert.match(result.content, /denied by approval/)
    await assert.rejects(fs.stat(path.join(root, 'a.txt')))
})

test('../ 与绝对路径在工具层同样被拒', async (t) => {
    const { root } = await makeWorkspace(t)
    const ctx = await makeStack({ workspace: root })
    ctx.approval.setAnswerer(() => true)

    const escapeAttempt = await callTool(
        ctx,
        'write_file',
        { path: '../outside/evil.txt', content: 'x' },
        contextFor(ctx),
    )
    assert.equal(escapeAttempt.isError, true)
    assert.match(escapeAttempt.content, /escapes the workspace/)

    const absolute = await callTool(
        ctx,
        'write_file',
        { path: path.join(os.tmpdir(), 'evil.txt'), content: 'x' },
        contextFor(ctx),
    )
    assert.equal(absolute.isError, true)
    assert.match(absolute.content, /absolute paths are not allowed/)
})

test('workspace 内指向外部的软链在工具层被拒', async (t) => {
    const { root, outside } = await makeWorkspace(t)
    await fs.symlink(outside, path.join(root, 'escape'), 'junction')
    const ctx = await makeStack({ workspace: root })
    ctx.approval.setAnswerer(() => true)

    const read = await callTool(ctx, 'read_file', { path: 'escape/secret.txt' }, contextFor(ctx))
    assert.equal(read.isError, true)
    assert.match(read.content, /through a symlink/)

    const write = await callTool(
        ctx,
        'write_file',
        { path: 'escape/new.txt', content: 'x' },
        contextFor(ctx),
    )
    assert.equal(write.isError, true)
    assert.match(write.content, /through a symlink/)
})

test('shell：没有审批通道时 fail closed', async (t) => {
    const { root } = await makeWorkspace(t)
    const ctx = await makeStack({ workspace: root, withApproval: false, runner: okRunner })

    const result = await callTool(ctx, 'shell', { command: 'echo hi' }, contextFor(ctx, false))

    assert.equal(result.isError, true)
    assert.match(result.content, /approval required/)
})

test('shell：超时会被记录', async (t) => {
    const { root } = await makeWorkspace(t)
    const ctx = await makeStack({ workspace: root, runner: timedOutRunner, timeoutMs: 1000 })
    ctx.approval.setAnswerer(() => true)

    const result = await callTool(ctx, 'shell', { command: 'sleep 10' }, contextFor(ctx))

    assert.equal(result.isError, false)
    assert.match(result.content, /timed out after 1000ms/)
})

test('shell：输出被截断到配置上限', async (t) => {
    const { root } = await makeWorkspace(t)
    const ctx = await makeStack({
        workspace: root,
        runner: chattyRunner,
        maxOutputChars: 10,
    })
    ctx.approval.setAnswerer(() => true)

    const result = await callTool(ctx, 'shell', { command: 'yes' }, contextFor(ctx))

    assert.match(result.content, /output truncated to 10 chars/)
    const body = result.content.split('\n')[0] ?? ''
    assert.ok(body.length <= 10, `body length ${body.length}`)
})

test('shell：runner 收到 workspace cwd，且 timeout_ms 只能缩短', async (t) => {
    const { root } = await makeWorkspace(t)
    let seen: CommandOptions | undefined
    const spyRunner: CommandRunner = async (_command, options) => {
        seen = options
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, truncated: false }
    }
    const ctx = await makeStack({ workspace: root, runner: spyRunner, timeoutMs: 5000 })
    ctx.approval.setAnswerer(() => true)

    await callTool(ctx, 'shell', { command: 'echo hi', timeout_ms: 100 }, contextFor(ctx))

    assert.equal(seen?.timeoutMs, 100)
    assert.equal(seen?.cwd, ctx.sandbox.workspace)

    await callTool(ctx, 'shell', { command: 'echo hi', timeout_ms: 999_999 }, contextFor(ctx))
    assert.equal(seen?.timeoutMs, 5000)
})

test('glob / grep 在 workspace 内工作', async (t) => {
    const { root } = await makeWorkspace(t)
    await fs.mkdir(path.join(root, 'src'))
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const answer = 42\n', 'utf8')
    await fs.writeFile(path.join(root, 'readme.md'), '# hi\n', 'utf8')
    const ctx = await makeStack({ workspace: root })

    const globbed = await callTool(ctx, 'glob', { pattern: '**/*.ts' }, contextFor(ctx))
    assert.match(globbed.content, /src\/a\.ts/)
    assert.doesNotMatch(globbed.content, /readme\.md/)

    const grepped = await callTool(ctx, 'grep', { pattern: 'answer' }, contextFor(ctx))
    assert.match(grepped.content, /src\/a\.ts:1:/)
})

test('approval 默认拒绝，setAnswerer 后放行，disposer 恢复拒绝', async () => {
    const ctx = new Context()
    await ctx.plugin(approval)

    assert.equal(await ctx.approval.request({ tool: 'x', reason: 'y' }), 'deny')
    assert.equal(ctx.approval.hasAnswerer, false)

    const dispose = ctx.approval.setAnswerer(() => true)
    assert.equal(ctx.approval.hasAnswerer, true)
    assert.equal(await ctx.approval.request({ tool: 'x', reason: 'y' }), 'allow')

    dispose()
    assert.equal(await ctx.approval.request({ tool: 'x', reason: 'y' }), 'deny')
})

test('CLI answerer：空回车 / y 允许，n 拒绝', async () => {
    const allow = createApprovalAnswerer(async () => '')
    const yes = createApprovalAnswerer(async () => 'Yes')
    const no = createApprovalAnswerer(async () => 'n')

    assert.equal(await allow({ tool: 'write_file', reason: 'x' }), true)
    assert.equal(await yes({ tool: 'write_file', reason: 'x' }), true)
    assert.equal(await no({ tool: 'write_file', reason: 'x' }), false)
})
