import fs from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../core/tool.ts'
import { approve, readBoolean, readString, resolveTarget } from './guard.ts'

/**
 * D7：文件工具。读不做审批，写 / 编辑先过 sandbox 闸门再过审批。
 */

const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace.',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace.' } },
        required: ['path'],
    },
    async execute(args, exec) {
        const input = readString(args, 'path')
        if (!input) throw new Error('path is required')
        const target = await resolveTarget(exec, input, 'read')
        return await fs.readFile(target, 'utf8')
    },
}

const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: 'Write a UTF-8 text file inside the workspace (requires approval).',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            content: { type: 'string' },
        },
        required: ['path', 'content'],
    },
    async execute(args, exec) {
        const input = readString(args, 'path')
        const content = readString(args, 'content')
        if (!input) throw new Error('path is required')
        if (content === undefined) throw new Error('content must be a string')

        const target = await resolveTarget(exec, input, 'write')
        await approve(exec, { tool: 'write_file', reason: `write ${input}`, detail: target })
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, 'utf8')
        return `wrote ${content.length} char(s) to ${input}`
    },
}

const editFileTool: ToolDefinition = {
    name: 'edit_file',
    description: 'Replace a literal string in a workspace file (requires approval).',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
    },
    async execute(args, exec) {
        const input = readString(args, 'path')
        const oldString = readString(args, 'old_string')
        const newString = readString(args, 'new_string')
        const replaceAll = readBoolean(args, 'replace_all') ?? false
        if (!input) throw new Error('path is required')
        if (!oldString) throw new Error('old_string must be a non-empty string')
        if (newString === undefined) throw new Error('new_string must be a string')

        const target = await resolveTarget(exec, input, 'write')
        await approve(exec, { tool: 'edit_file', reason: `edit ${input}`, detail: target })

        const original = await fs.readFile(target, 'utf8')
        const occurrences = original.split(oldString).length - 1
        if (occurrences === 0) throw new Error(`old_string not found in ${input}`)
        if (occurrences > 1 && !replaceAll) {
            throw new Error(
                `old_string appears ${occurrences} times in ${input}; add more context or set replace_all`,
            )
        }

        const updated = replaceAll
            ? original.split(oldString).join(newString)
            : original.replace(oldString, newString)
        await fs.writeFile(target, updated, 'utf8')
        return `edited ${input} (${replaceAll ? occurrences : 1} replacement(s))`
    },
}

/** cordis 插件显示名。 */
export const name = 'tiny-files'

/** 通过 ctx.tools 注册。 */
export const inject = ['tools']

/** 注册 read_file / write_file / edit_file。 */
export function apply(ctx: Context): void {
    ctx.tools.register(readFileTool)
    ctx.tools.register(writeFileTool)
    ctx.tools.register(editFileTool)
}
