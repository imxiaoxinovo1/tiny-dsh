import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * D6：把身份与实时环境注入 system prompt。
 *
 * 时间、cwd、平台都是 harness 状态，不是模型知识 —— 所以用 `context()`（工厂），
 * 每一步 assemble 都重新读一次。时钟可注入，测试不必依赖真实时间。
 */

/** runtime-context 插件配置。 */
export interface RuntimeContextConfig {
    /** 工作目录；缺省进程 cwd。 */
    workspace?: string
    /** 注入时钟；缺省系统时间。 */
    now?: () => Date
}

/** cordis 插件显示名。 */
export const name = 'tiny-runtime-context'

/** 需要 ctx.systemPrompt 才能注册片段。 */
export const inject = ['systemPrompt']

/** 注册身份 section 与环境 context。 */
export function apply(ctx: Context, config: RuntimeContextConfig = {}): void {
    const workspace = path.resolve(config.workspace ?? process.cwd())
    const now = config.now ?? (() => new Date())

    ctx.systemPrompt.section({
        name: 'agent:identity',
        order: 10,
        text: [
            'You are a general-purpose coding agent running in a local harness.',
            'Use the provided tools to inspect and change the workspace instead of guessing.',
            'Reply in the language the user writes in.',
        ].join('\n'),
    })

    ctx.systemPrompt.context({
        name: 'runtime:environment',
        order: 100,
        text: () =>
            [
                '## Runtime Context',
                `- Current time: ${now().toISOString()}`,
                `- Workspace: ${workspace}`,
                `- Platform: ${process.platform} ${process.arch}`,
                `- Node.js: ${process.version}`,
            ].join('\n'),
    })
}
