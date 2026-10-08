import type { ChatMessage } from '../../src/core/message.ts'

export interface ExperimentCase {
    id: string
    task: string
    messages: ChatMessage[]
    facts: string[]
    probe: string
    expected: string[]
    important: number[]
}
const user = (content: string): ChatMessage => ({ role: 'user', content })
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content })
const noise = (): ChatMessage[] => [
    user('Thanks. Can you explain the general approach?'),
    assistant('Inspect the code, make a focused change, then validate it. '.repeat(12)),
]

export const experimentCases: ExperimentCase[] = [
    {
        id: 'active-constraint',
        task: 'Continue updating the CLI without touching protected files.',
        messages: [
            user(
                'Update src/cli/repl.ts. Do not modify pnpm-lock.yaml. Keep Node 22.18 compatibility.',
            ),
            assistant('I will keep these constraints.'),
            ...noise(),
            user('The prompt should be minimal.'),
            assistant('Next: change the prompt renderer.'),
        ],
        facts: ['src/cli/repl.ts', 'pnpm-lock.yaml', '22.18'],
        important: [0, 4],
        probe: 'Return the target file, the file that must not be modified, and the minimum Node version.',
        expected: ['src/cli/repl.ts', 'pnpm-lock.yaml', '22.18'],
    },
    {
        id: 'tool-metadata',
        task: 'Fix the test failure and rerun the exact command.',
        messages: [
            user('Diagnose the failing permission test.'),
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'call_test',
                        type: 'function',
                        function: {
                            name: 'shell',
                            arguments: JSON.stringify({
                                command: 'node --test test/permissions.test.ts',
                            }),
                        },
                    },
                ],
            },
            {
                role: 'tool',
                tool_call_id: 'call_test',
                content: 'Exit 1: assertion failed at line 42. No fix applied.',
            },
            assistant('We need to fix the assertion before rerunning.'),
            ...noise(),
        ],
        facts: ['shell', 'node --test test/permissions.test.ts', '42'],
        important: [1, 2, 3],
        probe: 'Return the exact command to rerun, the failure line, and whether the fix has been applied (yes/no).',
        expected: ['node --test test/permissions.test.ts', '42', 'no'],
    },
    {
        id: 'superseded-decision',
        task: 'Continue using the corrected port and configuration.',
        messages: [
            user('Set the development port to 3000.'),
            assistant('Plan: port 3000.'),
            ...noise(),
            user('Correction: use port 4317 instead of 3000. Change config/dev.json.'),
            assistant('The 4317 setting is planned but not yet written.'),
        ],
        facts: ['4317', 'config/dev.json'],
        important: [4, 5],
        probe: 'Return only the currently requested port and configuration file.',
        expected: ['4317', 'config/dev.json'],
    },
    {
        id: 'pending-failure',
        task: 'Continue after the blocked write without claiming success.',
        messages: [
            user('Write the report into docs/report.md, but ask me before writing.'),
            assistant('Requested approval for write_file.'),
            {
                role: 'tool',
                tool_call_id: 'call_write',
                content: 'write_file denied by approval; docs/report.md was not created.',
            },
            assistant('Waiting for user approval. Do not report the file as created.'),
            ...noise(),
        ],
        facts: ['docs/report.md', 'approval'],
        important: [0, 2, 3],
        probe: 'Return the pending path, whether it exists (yes/no), and the blocker.',
        expected: ['docs/report.md', 'no', 'approval'],
    },
    {
        id: 'chinese-constraint',
        task: '继续本地实验并保留数据边界。',
        messages: [
            user('只在本地测试，禁止上传。使用 fixtures/v2.json，不能混用 fixtures/v1.json。'),
            assistant('后续会遵守这些限制。'),
            ...noise(),
            user('输出结果到 .tmp/results.json。'),
            assistant('等待运行实验。'),
        ],
        facts: ['fixtures/v2.json', 'fixtures/v1.json', '.tmp/results.json'],
        important: [0, 4],
        probe: '回答使用的数据路径、禁止混用的数据路径、输出路径，以及是否允许上传（用 no 表示不允许）。',
        expected: ['fixtures/v2.json', 'fixtures/v1.json', '.tmp/results.json', 'no'],
    },
    {
        id: 'result-versus-plan',
        task: 'Implement pagination, preserving the validated baseline.',
        messages: [
            user('Add pagination to src/api/list.ts. Keep the response field nextCursor.'),
            assistant('Baseline passed 17 tests. Pagination is not implemented yet.'),
            ...noise(),
            user('Run node --test test/list.test.ts after the change.'),
            assistant('Next: implement pagination and validate.'),
        ],
        facts: ['src/api/list.ts', 'nextCursor', '17', 'node --test test/list.test.ts'],
        important: [0, 1, 4],
        probe: 'Return the target file, required response field, baseline test count, and exact validation command.',
        expected: ['src/api/list.ts', 'nextCursor', '17', 'node --test test/list.test.ts'],
    },
]
