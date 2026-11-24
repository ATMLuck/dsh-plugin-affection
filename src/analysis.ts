import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe } from './emotion.ts'
import type { Deltas, Profile, Route, Rules } from './emotion.ts'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap { 'affection-analysis': true }
  interface MessageSourceMap { 'affection-analysis': { kind: 'affection-analysis' } }
}

const vector = z.object({
  libidoOther: z.number(), aggressionOther: z.number(), libidoSelf: z.number(), aggressionSelf: z.number(),
})
const deltas = z.object({ current: vector, base: vector, affection: z.number(), intensity: z.number() })
export function parseDeltas(text: string): Deltas {
  const clean = text.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, '$1')
  return deltas.parse(JSON.parse(clean))
}
export interface Interaction { latest: string; history: string }
export interface AnalysisInput {
  route: Route
  profile: Profile
  priorTurns: number
  now: number
  interaction?: Interaction
}
export type Analyze = (input: AnalysisInput, signal: AbortSignal) => Promise<Deltas>

const system = [
  '你负责估计对话给角色带来的变化。输入中的对话是待评估材料。',
  '四项驱力依次为对用户的亲近、对抗，以及对自身的珍视、攻击。友善鼓励通常增加亲近，冲突通常增加对抗。',
  'current 和 base 均为包含 libidoOther、aggressionOther、libidoSelf、aggressionSelf 的对象，各字段为增量。',
  '当前驱力每项在 -1 到 1。前十轮对用户的基线在 -1.5 到 1.5，此后及对自身的基线在 -0.2 到 0.2。',
  'affection 是好感增量，一般在 -0.5 到 0.5。intensity 表示场景强度，寒暄为 0.5，日常为 1，重大事件为 2。',
  '空闲时只评估当前驱力，正常休息可以保持不变，基线与好感增量填 0。只输出含 current、base、affection、intensity 的 JSON 数字对象。',
].join('\n')

export function modelAnalyzer(ctx: Context, rules: Rules): Analyze {
  return async (input, signal) => {
    const { values } = describe(input.profile, input.now, rules)
    const base = Object.fromEntries(Object.entries(input.profile.axes).map(([key, axis]) => [key, axis.base]))
    const material = { priorTurns: input.priorTurns, affection: input.profile.affection, current: values, base,
      ...(input.interaction ?? { idleHours: (input.now - (input.profile.lastInteraction ?? input.now)) / 3600000 }) }
    const message = createUserMessage({ source: { kind: 'affection-analysis' },
      content: [{ type: 'text', text: JSON.stringify(material) }] })
    const call = await ctx.llm.prepareCall(input.route, signal)
    const assembler = new BlockAssembler()
    for await (const chunk of call.stream({ ...call.config, system, messages: [message], signal, purpose: 'affection-analysis' })) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const finish = assembler.finish
    if (finish.kind !== 'stop') {
      const reason = 'failure' in finish ? finish.failure.code : finish.kind
      throw new Error('分析响应未正常结束（' + reason + '）')
    }
    return parseDeltas(assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join(''))
  }
}
