import { TerminalView } from '../src/cli/ui.ts'

const view = new TerminalView()
view.header({
    model: 'deepseek/deepseek-v4-flash',
    workspace: process.cwd(),
    permission: 'workspace-write',
    semantic: 'off',
})
process.stdout.write(`${view.prompt()}Explain how sessions are restored\n\n`)
view.tool({ id: 'preview', name: 'read_file', arguments: { path: 'src/core/persistence.ts' } })
view.content(
    'Sessions are restored from an append-only JSONL event log.\n' +
        'Invalid event lines are skipped; valid events are replayed into the session.\n',
)
view.finish(2, 1400)
process.stdout.write(`${view.prompt()}\n`)
