import type { ApprovalRequest } from '../core/tool.ts'

/** 提问函数；CLI 传 readline，测试传固定答案。 */
export type Ask = (question: string) => Promise<string>

/**
 * 把 CLI 的 `[Y/n]` 回答转成审批结果。
 *
 * 空回车 / y / yes 视为允许（默认 Y），其它一律拒绝。
 */
export function createApprovalAnswerer(ask: Ask): (request: ApprovalRequest) => Promise<boolean> {
    return async (request) => {
        const detail = request.detail ? `\n  ${request.detail}` : ''
        const answer = await ask(`\nAllow ${request.tool}? ${request.reason}${detail} [Y/n] `)
        const normalized = answer.trim().toLowerCase()
        return normalized === '' || normalized === 'y' || normalized === 'yes'
    }
}
