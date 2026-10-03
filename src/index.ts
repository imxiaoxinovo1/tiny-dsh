import { Context } from '@deepseek-ai/cordis'
import dotenv from 'dotenv'
import * as agentLoop from './plugins/agent-loop.ts'
import * as agents from './plugins/agents.ts'
import * as hello from './plugins/hello.ts'
import * as llm from './plugins/llm.ts'
import * as runtimeContext from './plugins/runtime-context.ts'
import * as sessions from './plugins/sessions.ts'
import * as systemPrompt from './plugins/system-prompt.ts'
import * as tools from './plugins/tools.ts'
import * as deepseek from './providers/deepseek.ts'

// 组合根：所有能力都通过 root.plugin() 挂载，模块之间不直接 import，
// 跨模块通信一律走 ctx.<service>（见 ARCHITECTURE.md 设计原则 1）。
// 环境变量只在这里读取，再以 config 形式传给插件。
dotenv.config({ quiet: true })

const workspace = process.env.TINY_DSH_WORKSPACE ?? process.cwd()
const root = new Context()

// 按「总体实现设计」第 2 节的依赖顺序挂载；顺序由 inject 决定，这里只是可读性。
await root.plugin(sessions)
await root.plugin(systemPrompt)
await root.plugin(tools)
await root.plugin(llm)
await root.plugin(agentLoop)
await root.plugin(agents)
await root.plugin(hello)
await root.plugin(runtimeContext, { workspace })

// 没有 API key 也能启动：provider 只在使用时才校验 key。
await root.plugin(deepseek, {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
})

// D7 之前还没有 CLI，先用内联 echo 工具演示注册 → schema → 执行流水线。
root.tools.register({
    name: 'echo',
    description: 'Echo back the given text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => args,
})

const session = root.sessions.create({ title: 'boot' })
root.sessions.append(session.id, 'user/message', { content: 'hello' })
const echo = await root.tools.execute({ id: 'boot-1', name: 'echo', arguments: { text: 'ping' } })
const prompt = await root.systemPrompt.assemble()

console.log(`tiny-dsh: ${root.constructor.name} ready`)
console.log(`  ctx.hello.greet('world') -> ${root.hello.greet('world')}`)
console.log(
    `  ctx.sessions -> ${root.sessions.list().length} session(s), ` +
        `${root.sessions.deriveMessages(session.id).length} projected message(s)`,
)
console.log(`  ctx.tools -> ${root.tools.schemas().length} tool(s), echo -> ${echo.content}`)
console.log(`  ctx.agents -> ${root.agents.list().length} agent(s), agentLoop ready`)
console.log(
    `  ctx.llm -> ${
        root.llm
            .list()
            .map((provider) => provider.name)
            .join(', ') || '(none)'
    }`,
)
console.log(
    `  ctx.systemPrompt -> ${root.systemPrompt.list().length} fragment(s), ${prompt.length} chars`,
)
