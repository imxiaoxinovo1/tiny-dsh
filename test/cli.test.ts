import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runSlashCommand } from '../src/cli/commands.ts'
import { cellWidth, TerminalView } from '../src/cli/ui.ts'

test('unknown slash commands remain local instead of reaching the model', async () => {
    const ports = { sessions: { create: () => ({ id: 'new' }), clear: () => {} } }
    assert.match(
        (await runSlashCommand('/typo', ports, { sessionId: 'old' }))?.output ?? '',
        /unknown command/,
    )
    assert.equal(await runSlashCommand('hello', ports, { sessionId: 'old' }), undefined)
    assert.equal((await runSlashCommand('/new', ports, { sessionId: 'old' }))?.sessionId, 'new')
})

test('plain output keeps metadata compact and sanitizes tool arguments', () => {
    let output = ''
    const view = new TerminalView({
        write: (text) => {
            output += text
        },
        isTTY: false,
    })
    view.header({
        model: 'mock/model',
        workspace: 'workspace',
        permission: 'workspace-write',
        semantic: 'off',
    })
    view.thinking()
    view.tool({ id: 'c', name: 'shell', arguments: { command: '\x1b[2J\nunsafe' } })
    view.content('answer')
    view.finish(2, 1000)
    assert.equal(output.includes('\x1b'), false)
    assert.match(output, /answer\n/)
    assert.equal(output.includes('ctx.sessions'), false)
})

test('welcome card fits narrow terminals and wide Chinese paths without control sequences', () => {
    for (const columns of [24, 40, 60, 80]) {
        let output = ''
        const view = new TerminalView({
            columns,
            isTTY: false,
            write: (chunk) => {
                output += chunk
            },
        })
        view.header({
            model: 'deepseek/deepseek-v4-flash',
            workspace: 'E:/项目/非常长的中文文件夹/冰川研究/实验文件/代码目录/tiny-dsh',
            permission: 'workspace-write',
            semantic: 'off',
        })
        assert.equal(output.includes('\x1b'), false)
        for (const line of output.split('\n'))
            assert.ok(cellWidth(line) <= columns, `line exceeds terminal width: ${line}`)
    }
})

test('stream chunks preserve indentation and new turns reset activity counts', () => {
    let output = ''
    const view = new TerminalView({
        isTTY: false,
        write: (chunk) => {
            output += chunk
        },
    })
    view.beginTurn()
    view.content('hello')
    view.content(' world\n  code')
    view.content('\nnext\n')
    assert.match(output, / {2}hello world\n {4}code\n {2}next\n/)
    view.tool({ id: 'c', name: 'read_file', arguments: { path: 'a.ts' } })
    view.beginTurn()
    view.finish(1, 100)
    assert.equal(output.includes('tools'), false)
})
