import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'commands', 'llm']
export function apply(ctx) {
  class SeedModel extends LlmAdapter {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['affection-seed'], new SeedModel())
  const timer = setTimeout(async () => {
    try {
      const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { agentPreset: 'standard' },
        agentOptions: { provider: 'affection-seed', model: 'fixed' } })
      const agent = handle.agent
      agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'建档'}]}))
      await agent.whenIdle()
      const reply = await ctx.commands.execute(agent, '/set_emotion affection=67 libidoOther=31', [], new AbortController().signal)
      assert.equal(reply?.result.kind, 'success')
      await handle.dispose()
      console.log('AFFECTION_LEGACY_SEED_OK')
      process.exit(0)
    } catch (error) { console.error(error); process.exit(1) }
  }, 350)
  ctx.effect(() => () => clearTimeout(timer))
}
