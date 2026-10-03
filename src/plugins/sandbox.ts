import path from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import { PathGate, type PathIntent } from '../core/path.ts'
import type { SandboxMode } from '../core/tool.ts'

/**
 * D7：把 `PathGate` 包成 `ctx.sandbox`。
 *
 * 注意：Service 的方法经 cordis tracing 代理后 `this` 是影子代理，
 * 所以这里**不用 `#` 私有字段**（私有字段无法穿过 Proxy），改用普通字段。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** workspace 路径闸门 + 命令策略。 */
        sandbox: SandboxService
    }
}

/** sandbox 配置。 */
export interface SandboxConfig {
    /** 工作目录；缺省进程 cwd。 */
    workspace?: string
    /** 权限模式；缺省 workspace-write。 */
    mode?: SandboxMode
}

export class SandboxService extends Service {
    /** 当前模式；由 permission presets 通过 setMode 改写。 */
    mode: SandboxMode
    /** workspace 的绝对路径（未 realpath；闸门内部会 realpath）。 */
    readonly workspace: string
    private gate: Promise<PathGate> | undefined

    constructor(ctx: Context, config: SandboxConfig = {}) {
        super(ctx, 'sandbox')
        this.workspace = path.resolve(config.workspace ?? process.cwd())
        this.mode = config.mode ?? 'workspace-write'
    }

    /** 切换模式；permission presets 的写路径。 */
    setMode(mode: SandboxMode): void {
        this.mode = mode
    }

    private gateway(): Promise<PathGate> {
        this.gate ??= PathGate.open(this.workspace)
        return this.gate
    }

    /** 解析并校验路径；越界 / 绝对路径 / 软链逃逸都会 reject。 */
    async resolvePath(input: string, intent: PathIntent = 'read'): Promise<string> {
        if (this.mode === 'read-only' && intent === 'write') {
            throw new Error(`sandbox is read-only: cannot write "${input}"`)
        }
        if (this.mode === 'danger-full-access') {
            return path.resolve(this.workspace, input)
        }
        return (await this.gateway()).resolve(input, intent)
    }

    /** 命令策略；D7 只在 read-only 下禁用 shell。 */
    async checkCommand(command: string): Promise<void> {
        if (this.mode === 'read-only') {
            throw new Error(`sandbox is read-only: shell commands are disabled (${command})`)
        }
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-sandbox'

/** 挂载 `ctx.sandbox`。 */
export function apply(ctx: Context, config: SandboxConfig = {}): void {
    ctx.plugin(SandboxService, config)
}
