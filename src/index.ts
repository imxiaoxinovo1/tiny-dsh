import { Context } from '@deepseek-ai/cordis'
import * as hello from './plugins/hello.ts'
import * as sessions from './plugins/sessions.ts'
import * as tools from './plugins/tools.ts'

// 组合根：所有能力都通过 root.plugin() 挂载，模块之间不直接 import，
// 跨模块通信一律走 ctx.<service>（见 ARCHITECTURE.md 设计原则 1）。
// 按「总体实现设计」第 2 节的依赖顺序追加插件。
const root = new Context()

await root.plugin(sessions)
await root.plugin(tools)
await root.plugin(hello)

// D3 还没有 CLI，先用一个内联 echo 工具演示注册 → schema → 执行流水线。
root.tools.register({
    name: 'echo',
    description: 'Echo back the given text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => args,
})

const session = root.sessions.create({ title: 'boot' })
root.sessions.append(session.id, 'user/message', { content: 'hello' })
const echo = await root.tools.execute({ id: 'boot-1', name: 'echo', arguments: { text: 'ping' } })

console.log(`tiny-dsh: ${root.constructor.name} ready`)
console.log(`  ctx.hello.greet('world') -> ${root.hello.greet('world')}`)
console.log(
    `  ctx.sessions -> ${root.sessions.list().length} session(s), ` +
        `${root.sessions.deriveMessages(session.id).length} projected message(s)`,
)
console.log(`  ctx.tools -> ${root.tools.schemas().length} tool(s), echo -> ${echo.content}`)
