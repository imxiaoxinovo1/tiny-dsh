import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '../core/tool.ts'
import { readString, workspaceOf } from './guard.ts'

/**
 * D7：只读检索工具。自带一个很小的递归遍历 + glob 匹配，避免引入额外依赖。
 */

const DEFAULT_IGNORES = new Set(['node_modules', '.git', '.DS_Store'])
const MAX_FILES = 2000
const MAX_MATCHES = 200

/** 把 glob 转成正则：支持 `**`、`*`、`?`，路径统一按 `/` 处理。 */
export function globToRegExp(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
    let source = ''
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized.charAt(i)
        if (char === '*') {
            if (normalized.charAt(i + 1) === '*') {
                if (normalized.charAt(i + 2) === '/') {
                    source += '(?:.*/)?'
                    i += 2
                } else {
                    source += '.*'
                    i += 1
                }
            } else {
                source += '[^/]*'
            }
        } else if (char === '?') {
            source += '[^/]'
        } else if ('\\^$.|+()[]{}'.includes(char)) {
            source += `\\${char}`
        } else {
            source += char
        }
    }
    return new RegExp(`^${source}$`)
}

/** 递归列出 workspace 下的文件（相对路径，正斜杠）。 */
export async function listFiles(root: string): Promise<string[]> {
    const files: string[] = []
    const stack: string[] = ['']
    while (stack.length > 0 && files.length < MAX_FILES) {
        const relative = stack.pop()
        if (relative === undefined) continue
        let entries: Dirent[]
        try {
            entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            if (DEFAULT_IGNORES.has(entry.name)) continue
            const child = relative ? `${relative}/${entry.name}` : entry.name
            if (entry.isDirectory()) stack.push(child)
            else files.push(child)
        }
    }
    return files
}

function sandboxOf(exec: ToolExecution): NonNullable<ToolExecution['sandbox']> {
    const sandbox = exec.sandbox
    if (!sandbox) throw new Error('sandbox is unavailable: cannot search the workspace')
    return sandbox
}

const globTool: ToolDefinition = {
    name: 'glob',
    description: 'List workspace files matching a glob pattern (supports **, *, ?).',
    parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
    },
    async execute(args, exec) {
        const pattern = readString(args, 'pattern')
        if (!pattern) throw new Error('pattern is required')
        const matcher = globToRegExp(pattern)
        const matched = (await listFiles(workspaceOf(exec))).filter((file) => matcher.test(file))
        return matched.length > 0 ? matched.join('\n') : 'no matches'
    },
}

const grepTool: ToolDefinition = {
    name: 'grep',
    description: 'Search workspace files for a JavaScript regular expression.',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string' },
            include: { type: 'string', description: 'Optional glob filter, e.g. **/*.ts' },
        },
        required: ['pattern'],
    },
    async execute(args, exec) {
        const pattern = readString(args, 'pattern')
        if (!pattern) throw new Error('pattern is required')
        const include = readString(args, 'include')
        const sandbox = sandboxOf(exec)
        const regex = new RegExp(pattern)
        const includeMatcher = include ? globToRegExp(include) : undefined

        const matches: string[] = []
        for (const file of await listFiles(sandbox.workspace)) {
            if (matches.length >= MAX_MATCHES) break
            if (includeMatcher && !includeMatcher.test(file)) continue

            let content: string
            try {
                content = await fs.readFile(await sandbox.resolvePath(file, 'read'), 'utf8')
            } catch {
                continue
            }
            const lines = content.split('\n')
            for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
                const line = lines[i]
                if (line !== undefined && regex.test(line)) {
                    matches.push(`${file}:${i + 1}: ${line.trim()}`)
                }
            }
        }
        return matches.length > 0 ? matches.join('\n') : 'no matches'
    },
}

/** cordis 插件显示名。 */
export const name = 'tiny-search'

/** 通过 ctx.tools 注册。 */
export const inject = ['tools']

/** 注册 glob / grep。 */
export function apply(ctx: Context): void {
    ctx.tools.register(globTool)
    ctx.tools.register(grepTool)
}
