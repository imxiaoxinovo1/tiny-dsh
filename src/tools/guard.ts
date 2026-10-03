import type { ApprovalRequest, ToolExecution } from '../core/tool.ts'

/**
 * D7：工具侧的共享守卫。
 *
 * 两个能力都可能不存在（插件可卸载 / 在测试里没挂），**缺能力一律 fail closed**：
 * 没有 sandbox 就不碰文件，没有审批通道就不写。
 */

/** 解析 workspace 内的目标路径；没有 sandbox 时 fail closed。 */
export async function resolveTarget(
    exec: ToolExecution,
    input: string,
    intent: 'read' | 'write',
): Promise<string> {
    const sandbox = exec.sandbox
    if (!sandbox) throw new Error(`sandbox is unavailable: cannot ${intent} "${input}"`)
    return sandbox.resolvePath(input, intent)
}

/** 取 shell 的工作目录；没有 sandbox 时 fail closed。 */
export function workspaceOf(exec: ToolExecution): string {
    const sandbox = exec.sandbox
    if (!sandbox) throw new Error('sandbox is unavailable: cannot run shell commands')
    return sandbox.workspace
}

/** 请求审批；没有审批通道或未获批准时抛可读错误。 */
export async function approve(exec: ToolExecution, request: ApprovalRequest): Promise<void> {
    const approval = exec.approval
    if (!approval) {
        throw new Error(
            `approval required but no approval channel is configured: ${request.reason}`,
        )
    }
    const decision = await approval.request(request)
    if (decision !== 'allow') throw new Error(`denied by approval: ${request.reason}`)
}

/** 从工具参数里读一个字符串。 */
export function readString(args: unknown, key: string): string | undefined {
    if (typeof args !== 'object' || args === null) return undefined
    const value = (args as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : undefined
}

/** 从工具参数里读一个有限数字。 */
export function readNumber(args: unknown, key: string): number | undefined {
    if (typeof args !== 'object' || args === null) return undefined
    const value = (args as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 从工具参数里读一个布尔值。 */
export function readBoolean(args: unknown, key: string): boolean | undefined {
    if (typeof args !== 'object' || args === null) return undefined
    const value = (args as Record<string, unknown>)[key]
    return typeof value === 'boolean' ? value : undefined
}
