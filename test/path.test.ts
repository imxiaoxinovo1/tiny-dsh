import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type TestContext, test } from 'node:test'
import { PathGate, PathGateError } from '../src/core/path.ts'

// D7 验收：`../` 与绝对路径被拒；workspace 内指向外部的软链被拒。

async function makeWorkspace(t: TestContext): Promise<{ root: string; outside: string }> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-dsh-path-'))
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

test('workspace 内的相对路径正常解析（含还不存在的新文件）', async (t) => {
    const { root } = await makeWorkspace(t)
    const gate = await PathGate.open(root)

    assert.equal(await gate.resolve('src/a.ts'), path.join(gate.root, 'src', 'a.ts'))
    assert.equal(await gate.resolve('./src/b.ts'), path.join(gate.root, 'src', 'b.ts'))
    assert.equal(
        await gate.resolve('new/dir/file.txt', 'write'),
        path.join(gate.root, 'new', 'dir', 'file.txt'),
    )
})

test('../ 逃逸被拒', async (t) => {
    const { root } = await makeWorkspace(t)
    const gate = await PathGate.open(root)

    await assert.rejects(gate.resolve('../outside/secret.txt'), PathGateError)
    await assert.rejects(gate.resolve('nested/../../outside'), /escapes the workspace/)
})

test('绝对路径被拒', async (t) => {
    const { root, outside } = await makeWorkspace(t)
    const gate = await PathGate.open(root)

    await assert.rejects(
        gate.resolve(path.join(outside, 'secret.txt')),
        /absolute paths are not allowed/,
    )
})

test('workspace 内指向外部的软链被拒', async (t) => {
    const { root, outside } = await makeWorkspace(t)
    await fs.symlink(outside, path.join(root, 'escape'), 'junction')
    const gate = await PathGate.open(root)

    await assert.rejects(gate.resolve('escape/secret.txt', 'read'), /through a symlink/)
    await assert.rejects(gate.resolve('escape/new.txt', 'write'), /through a symlink/)
})

test('非法输入被拒：空路径与 NUL 字节', async (t) => {
    const { root } = await makeWorkspace(t)
    const gate = await PathGate.open(root)

    await assert.rejects(gate.resolve(''), /path is required/)
    await assert.rejects(gate.resolve('a\0b'), /NUL byte/)
})

test('workspace 内部真实存在的文件可以解析', async (t) => {
    const { root } = await makeWorkspace(t)
    await fs.mkdir(path.join(root, 'src'))
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export {}\n', 'utf8')
    const gate = await PathGate.open(root)

    assert.equal(await gate.resolve('src/a.ts'), path.join(gate.root, 'src', 'a.ts'))
    assert.equal(await gate.resolve('src/../src/a.ts'), path.join(gate.root, 'src', 'a.ts'))
})
