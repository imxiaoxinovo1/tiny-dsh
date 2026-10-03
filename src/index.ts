import { Context } from '@deepseek-ai/cordis'
import * as hello from './plugins/hello.ts'
import * as sessions from './plugins/sessions.ts'

// 组合根：所有能力都通过 root.plugin() 挂载，模块之间不直接 import，
// 跨模块通信一律走 ctx.<service>（见 ARCHITECTURE.md 设计原则 1）。
// D2 起按「总体实现设计」第 2 节的依赖顺序追加插件。
const root = new Context()

await root.plugin(sessions)
await root.plugin(hello)

const session = root.sessions.create({ title: 'boot' })
root.sessions.append(session.id, 'user/message', { content: 'hello' })

console.log(`tiny-dsh: ${root.constructor.name} ready`)
console.log(`  ctx.hello.greet('world') -> ${root.hello.greet('world')}`)
console.log(
    `  ctx.sessions -> ${root.sessions.list().length} session(s), ` +
        `${root.sessions.deriveMessages(session.id).length} projected message(s)`,
)
