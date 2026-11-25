import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { projectToolSchema } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import type { ChatSettings } from './settings.ts'

export function newChatState(settings: ChatSettings) {
  return { pinned: settings, turn: -1, steps: 0, toolBatch: false, answered: false }
}
export type ChatState = ReturnType<typeof newChatState>

/** The scope belongs to exactly one top-level agent. Tool resolution precedes pre-step. */
export function bindChat(ctx: Context, agent: Agent, read: () => ChatSettings, state: ChatState, firstTurn?: number) {
  function begin(turn: number) {
    if (turn === state.turn) return
    const latest = read()
    if (latest.enabled) state.pinned = latest
    state.turn = turn
    state.steps = 0
    state.toolBatch = false
    state.answered = false
  }
  if (firstTurn !== undefined) begin(firstTurn)
  const allowed = (name: string) => state.pinned.tools.includes(name)
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/start') begin(event.data.turn)
    if (event.type === 'step/start') state.steps++
    if (event.type === 'assistant/message') {
      state.answered = !event.data.message.content.some(block => block.type === 'tool-call')
    }
  })
  ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, complete: true,
    interpolate: false, text: () => state.pinned.persona })
  ctx.systemPrompt.suppressRuntimeContext()
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent === agent && (state.steps >= 2 || state.answered)) return { kind: 'reject' }
    return next()
  })
  // Both the declared schemas and native execution are the intersection of
  // the pinned names and the host's admitted definitions for this exact step.
  const pipeline = new ToolExecutionPipeline(ctx, {
    get: (name, scope, set) => !state.toolBatch && allowed(name) ? ctx.tools.executable(name, scope, set) : undefined,
  })
  ctx.tools.guard(exec => exec.agent === agent && (!allowed(exec.name) || state.toolBatch)
    ? '当前聊天未开放此工具。' : undefined)
  ctx.tools.setExecutor({
    describe(tools) {
      return { schemas: state.toolBatch || state.answered ? [] : tools.filter(t => allowed(t.name)).map(t => projectToolSchema(t, false)) }
    },
    async execute(input) {
      const final = state.toolBatch
      const result = await executeToolBatch(input, pipeline, () => 1)
      state.toolBatch = true
      return { ...result, concluded: final }
    },
  })
}
