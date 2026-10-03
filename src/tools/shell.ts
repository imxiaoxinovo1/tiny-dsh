import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../core/tool.ts'
import { approve, readNumber, readString, workspaceOf } from './guard.ts'

/**
 * D7：shell 工具。执行前过 sandbox 命令策略 + 审批；带超时与输出截断。
 *
 * 真正的子进程执行封装在可注入的 `CommandRunner` 里：测试注入假 runner，
 * 于是「超时 / 截断」这类策略可以脱离真实进程单测。
 */

export interface CommandOptions {
    cwd: string
    timeoutMs: number
    maxOutputChars: number
    signal?: AbortSignal
}

export interface CommandResult {
    stdout: string
    stderr: string
    exitCode: number | null
    timedOut: boolean
    truncated: boolean
}

/** 执行一条命令；默认实现用 node:child_process。 */
export type CommandRunner = (command: string, options: CommandOptions) => Promise<CommandResult>

export interface ShellToolConfig {
    /** 默认超时，可用参数 `timeout_ms` 缩短但不能放大。 */
    timeoutMs?: number
    /** stdout + stderr 各自最多保留的字符数。 */
    maxOutputChars?: number
    /** 测试注入点。 */
    runner?: CommandRunner
}

interface Sink {
    text: string
    truncated: boolean
}

function cap(sink: Sink, chunk: string, max: number): void {
    if (sink.truncated) return
    if (sink.text.length + chunk.length <= max) {
        sink.text += chunk
        return
    }
    sink.text += chunk.slice(0, Math.max(0, max - sink.text.length))
    sink.truncated = true
}

/** 默认 runner：spawn + pipe + 超时强杀 + 输出截断。 */
export const defaultRunner: CommandRunner = (command, options) =>
    new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, {
            cwd: options.cwd,
            shell: true,
            signal: options.signal,
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        const stdout: Sink = { text: '', truncated: false }
        const stderr: Sink = { text: '', truncated: false }
        let timedOut = false

        const timer = setTimeout(() => {
            timedOut = true
            child.kill()
        }, options.timeoutMs)

        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => cap(stdout, chunk, options.maxOutputChars))
        child.stderr?.on('data', (chunk: string) => cap(stderr, chunk, options.maxOutputChars))

        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            resolve({
                stdout: stdout.text,
                stderr: stderr.text,
                exitCode: code,
                timedOut,
                truncated: stdout.truncated || stderr.truncated,
            })
        })
    })

/** 构造 shell 工具（可注入 runner，便于测试）。 */
export function createShellTool(config: ShellToolConfig = {}): ToolDefinition {
    const defaultTimeout = config.timeoutMs ?? 30_000
    const maxOutputChars = config.maxOutputChars ?? 20_000
    const runner = config.runner ?? defaultRunner

    return {
        name: 'shell',
        description: 'Run a shell command in the workspace and return its output.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string' },
                timeout_ms: {
                    type: 'number',
                    description: 'Optional; can only shorten the default.',
                },
            },
            required: ['command'],
        },
        async execute(args, exec) {
            const command = readString(args, 'command')
            if (!command) throw new Error('command is required')

            const sandbox = exec.sandbox
            if (!sandbox) throw new Error('sandbox is unavailable: cannot run shell commands')
            await sandbox.checkCommand(command)
            await approve(exec, { tool: 'shell', reason: 'run shell command', detail: command })

            const requested = readNumber(args, 'timeout_ms')
            const timeoutMs =
                requested !== undefined && requested > 0
                    ? Math.min(requested, defaultTimeout)
                    : defaultTimeout

            const result = await runner(command, {
                cwd: workspaceOf(exec),
                timeoutMs,
                maxOutputChars,
                signal: exec.signal,
            })

            // 再兜一层：即使 runner 没截断，工具自身也保证上限。
            const stdoutSink: Sink = { text: '', truncated: false }
            const stderrSink: Sink = { text: '', truncated: false }
            cap(stdoutSink, result.stdout, maxOutputChars)
            cap(stderrSink, result.stderr, maxOutputChars)
            const truncated = result.truncated || stdoutSink.truncated || stderrSink.truncated

            const body = [stdoutSink.text.trim(), stderrSink.text.trim()].filter(Boolean).join('\n')
            const notes: string[] = []
            if (result.timedOut) notes.push(`timed out after ${timeoutMs}ms`)
            if (truncated) notes.push(`output truncated to ${maxOutputChars} chars`)
            if (result.exitCode !== 0) notes.push(`exit code ${result.exitCode}`)
            return [body, ...notes].filter(Boolean).join('\n') || '(no output)'
        },
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-shell'

/** 通过 ctx.tools 注册。 */
export const inject = ['tools']

/** 注册 shell 工具。 */
export function apply(ctx: Context, config: ShellToolConfig = {}): void {
    ctx.tools.register(createShellTool(config))
}
