import type { ToolCall } from '../core/message.ts'
import type { ToolResult } from '../core/tool.ts'

export interface TerminalOutput {
    write(text: string): unknown
    isTTY?: boolean
    columns?: number
}

interface HeaderInfo {
    model: string
    workspace: string
    permission: string
    semantic: string
}

const GLYPHS = [
    ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
    ['█████', '  █  ', '  █  ', '  █  ', '█████'],
    ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
    ['█   █', ' █ █ ', '  █  ', '  █  ', '  █  '],
    ['     ', '     ', '█████', '     ', '     '],
    ['████ ', '█   █', '█   █', '█   █', '████ '],
    [' ████', '█    ', ' ███ ', '    █', '████ '],
    ['█   █', '█   █', '█████', '█   █', '█   █'],
]
const TOOL_LABELS: Record<string, string> = {
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    shell: 'Run',
    glob: 'Find',
    grep: 'Search',
}

/** Display cell estimates for CJK/emoji; combining characters occupy no extra cell. */
export function cellWidth(text: string): number {
    return Array.from(text).reduce((total, character) => {
        if (/\p{Mark}/u.test(character)) return total
        const code = character.codePointAt(0) ?? 0
        const wide =
            (code >= 0x1100 && code <= 0x115f) ||
            (code >= 0x2e80 && code <= 0xa4cf) ||
            (code >= 0xac00 && code <= 0xd7a3) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xfe10 && code <= 0xfe6f) ||
            (code >= 0xff01 && code <= 0xff60) ||
            (code >= 0x1f300 && code <= 0x1faff) ||
            (code >= 0x20000 && code <= 0x3ffff)
        return total + (wide ? 2 : 1)
    }, 0)
}

function fit(text: string, width: number, tail = false): string {
    if (cellWidth(text) <= width) return text
    const characters = Array.from(text)
    if (tail) characters.reverse()
    const kept: string[] = []
    let cells = 1
    for (const character of characters) {
        const next = cellWidth(character)
        if (cells + next > width) break
        kept.push(character)
        cells += next
    }
    return tail ? `…${kept.reverse().join('')}` : `${kept.join('')}…`
}

/** Brand welcome page, quiet activity rows and streaming answer formatting. */
export class TerminalView {
    private timer: ReturnType<typeof setInterval> | undefined
    private lineOpen = false
    private answerStarted = false
    private toolCount = 0
    private readonly color: boolean
    private readonly output: TerminalOutput

    constructor(output: TerminalOutput = process.stdout, color = !('NO_COLOR' in process.env)) {
        this.output = output
        this.color = Boolean(output.isTTY && color)
    }

    private get width(): number {
        return Math.max(16, Math.min((this.output.columns ?? 80) - 2, 78))
    }

    private style(text: string, code: number): string {
        return this.color ? `\x1b[${code}m${text}\x1b[0m` : text
    }

    static clean(text: string): string {
        return Array.from(text, (character) => {
            const code = character.codePointAt(0) ?? 0
            return code < 32 || (code >= 127 && code <= 159) ? ' ' : character
        }).join('')
    }

    private newline(): void {
        if (this.lineOpen) this.output.write('\n')
        this.lineOpen = false
    }

    header(info: HeaderInfo, compact = false): void {
        this.output.write('\n')
        if (!compact && this.width >= 58) {
            for (let row = 0; row < 5; row++) {
                this.output.write(
                    `  ${GLYPHS.map((glyph, index) =>
                        this.style(glyph[row] ?? '', index < 4 ? 35 : 36),
                    ).join(' ')}\n`,
                )
            }
            this.output.write('\n')
        }
        this.output.write(
            `  ${this.style('Tiny-dsh', 1)}${this.style(this.width >= 28 ? '  /  coding agent' : '', 90)}\n\n`,
        )
        const inner = this.width - 4
        const edge = (left: string, right: string) => {
            this.output.write(`  ${this.style(left + '─'.repeat(inner) + right, 90)}\n`)
        }
        edge('╭', '╮')
        const fields = [
            ['Model', info.model],
            ['Folder', info.workspace],
            ['Access', info.permission],
            ['Jev', info.semantic],
        ]
        for (const [label = '', raw = ''] of fields) {
            const text =
                this.width >= 40
                    ? label.padEnd(8) + fit(TerminalView.clean(raw), inner - 10, label === 'Folder')
                    : fit(`${label}: ${TerminalView.clean(raw)}`, inner - 2)
            const padding = ' '.repeat(Math.max(0, inner - 2 - cellWidth(text)))
            this.output.write(`  ${this.style('│', 90)} ${text}${padding} ${this.style('│', 90)}\n`)
        }
        edge('╰', '╯')
        if (!compact) {
            this.output.write(
                `\n  ${this.style(fit('Describe a task to get started.', this.width - 2), 36)}\n`,
            )
            for (const hint of [
                '/help commands  ·  /new fresh session',
                'Ctrl+C cancel / exit  ·  /exit quit',
            ]) {
                this.output.write(`  ${this.style(fit(hint, this.width - 2), 90)}\n`)
            }
        }
    }

    prompt(): string {
        return `\n  ${this.style('─'.repeat(this.width - 2), 90)}\n  ${this.style('❯ ', 36)}`
    }

    beginTurn(): void {
        this.stopThinking()
        this.newline()
        this.answerStarted = false
        this.toolCount = 0
    }

    thinking(): void {
        this.stopThinking()
        if (!this.output.isTTY) return
        this.newline()
        let frame = 0
        const frames = ['·', '•', '●', '•']
        this.output.write(this.style('  · Thinking…', 90))
        this.timer = setInterval(() => {
            this.output.write(
                `\r\x1b[2K${this.style(`  ${frames[frame++ % frames.length]} Thinking…`, 90)}`,
            )
        }, 120)
        this.timer.unref()
    }

    stopThinking(): void {
        if (!this.timer) return
        clearInterval(this.timer)
        this.timer = undefined
        this.output.write('\r\x1b[2K')
    }

    content(chunk: string): void {
        if (!chunk) return
        this.stopThinking()
        if (!this.answerStarted) {
            this.newline()
            this.output.write(`\n  ${this.style('●', 36)} ${this.style('Tiny-dsh', 1)}\n\n`)
            this.answerStarted = true
        }
        // Preserve whitespace across stream chunks while writing whole fragments.
        for (const [index, fragment] of chunk.split('\n').entries()) {
            if (index > 0) {
                this.output.write('\n')
                this.lineOpen = false
            }
            if (!fragment) continue
            if (!this.lineOpen) this.output.write('  ')
            this.output.write(fragment)
            this.lineOpen = true
        }
    }

    tool(call: ToolCall): void {
        this.stopThinking()
        this.newline()
        this.answerStarted = false
        this.toolCount++
        const args = call.arguments as {
            path?: unknown
            command?: unknown
            pattern?: unknown
        } | null
        const detail = args?.path ?? args?.command ?? args?.pattern ?? ''
        const label = TOOL_LABELS[call.name] ?? call.name
        const text = TerminalView.clean(label + (detail ? `  ${String(detail)}` : ''))
        this.output.write(`  ${this.style('↳', 36)} ${this.style(fit(text, this.width - 4), 90)}\n`)
    }

    toolResult(result: ToolResult): void {
        if (result.content === 'Cancelled by user') return
        if (result.isError) this.notice(result.content.slice(0, 180), 'error')
    }

    notice(text: string, kind: 'info' | 'error' = 'info'): void {
        this.stopThinking()
        this.newline()
        const prefix = kind === 'error' ? '! ' : ''
        this.output.write(
            `  ${this.style(
                fit(prefix + TerminalView.clean(text), this.width - 2),
                kind === 'error' ? 31 : 90,
            )}\n`,
        )
    }

    finish(rounds: number, elapsedMs: number, capped = false): void {
        this.stopThinking()
        this.newline()
        this.output.write('\n')
        this.notice(
            '✓ ' +
                (elapsedMs / 1000).toFixed(1) +
                's  ·  ' +
                rounds +
                (rounds === 1 ? ' turn' : ' turns') +
                (this.toolCount
                    ? `  ·  ${this.toolCount} ${this.toolCount === 1 ? 'tool' : 'tools'}`
                    : '') +
                (capped ? '  ·  round limit reached' : ''),
        )
        this.answerStarted = false
        this.toolCount = 0
    }
}
