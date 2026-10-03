import type { Context } from '@deepseek-ai/cordis'
import { startRepl } from '../cli/repl.ts'

/**
 * D7：CLI 插件。
 *
 * 只在交互式 TTY 下启动 REPL；非交互（测试 / 管道）时什么都不做，于是
 * `pnpm start` 在终端里是 REPL，在 CI 里只是打印就绪后退出。
 */

/** CLI 配置。 */
export interface CliConfig {
    /** 默认模型，形如 provider/model。 */
    model?: string
    /** 覆盖 TTY 探测；测试用。 */
    interactive?: boolean
}

/** cordis 插件显示名。 */
export const name = 'tiny-cli'

/** 依赖 Agent 与 session 注册表；approval 是可选的。 */
export const inject = ['agents', 'sessions']

/** 交互式时启动 REPL。 */
export function apply(ctx: Context, config: CliConfig = {}): void {
    const interactive = config.interactive ?? Boolean(process.stdin.isTTY)
    if (!interactive) return

    const model = config.model ?? 'deepseek/deepseek-v4-flash'
    void startRepl(ctx, { model }).catch((error) => ctx.logger.error(error))
}
