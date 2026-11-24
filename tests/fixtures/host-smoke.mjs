// Loaded only by the isolated DSH smoke overlay; npm does not ship tests.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const name = 'affection-smoke'
export const inject = ['agents', 'agentLoop', 'commands', 'tools', 'llm', 'storageDomain', 'agentPresets']
export function apply(ctx) {
  const sandbox = relative(resolve('.local-test'), resolve(process.env.DSH_HOME ?? '.'))
  if (!sandbox || isAbsolute(sandbox) || sandbox.split(sep).includes('..')) throw new Error('Smoke fixture requires an isolated project home')
  const chats = [], analyses = []
  let askForTool = false
  ctx.tools.register(defineTool({
    name: 'affection_smoke_echo', description: 'Return the fixed test result', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    execute: async () => 'ok',
  }))
  class FixedModel extends LlmAdapter {
    async *stream(options) {
      const vector = { libidoOther: 1, aggressionOther: -1, libidoSelf: 0, aggressionSelf: 0 }
      const auxiliary = options.purpose === 'affection-analysis'
      if (auxiliary) analyses.push(options)
      else if (!options.purpose) chats.push(options)
      if (askForTool && !options.purpose) {
        askForTool = false
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: {type:'tool-call', id:'echo', name:'affection_smoke_echo', arguments:'{}'} }
        yield { type: 'finish', reason: {kind:'tool-calls'} }
        return
      }
      const text = auxiliary ? JSON.stringify({ current: vector, base: vector, affection: 1, intensity: 1 }) : '收到'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: {kind:'stop'} }
    }
  }
  ctx.llm.registerAdapter(['affection-fixture'], new FixedModel())
  const handles = []
  async function agent(preset, sub = false) {
    const handle = await ctx.agents.create({ sessionId: 'aff-' + randomUUID(), meta: { agentPreset: preset,
      ...(sub ? { origin:'subagent', delegationDepth:1 } : {}) }, agentOptions: {provider:'affection-fixture', model:'fixed'} })
    handles.push(handle)
    return handle.agent
  }
  async function cmd(a, line) {
    const got = await ctx.commands.execute(a,line,[],new AbortController().signal)
    assert.equal(got?.result.kind,'success', JSON.stringify(got))
    return got.result.text
  }
  async function send(a, text) {
    a.followup(createUserMessage({ source: {kind:'user'}, content:[{type:'text',text}] }))
    await a.whenIdle()
  }
  async function run() {
    // Plugin loading is concurrent. Wait for the installed bundle to open its domain.
    for (let i=0; i<200 && !ctx.storageDomain.get('dsh_affection'); i++) await delay(50)
    assert.ok(ctx.storageDomain.get('dsh_affection'), 'installed bundle did not open its domain')
    const a = await agent('standard')
    const runtime = [...ctx.registry.values()].find(item => item.name === 'affection')
    assert.ok(runtime, 'bundle fiber missing')
    const [fiber] = runtime.fibers
    if (process.env.AFFECTION_SMOKE_LIVE === '1') {
      const route = { provider: process.env.AFFECTION_LIVE_PROVIDER || 'deepseek-official',
        model: process.env.AFFECTION_LIVE_MODEL || 'deepseek-flash' }
      assert.ok(ctx.llm.listProviders().some(p => p.id === route.provider), 'requested DSH model route is unavailable')
      await fiber.update({ enabledPresets:['standard'], analysisRoute:route },true)
      await cmd(a,'/reset_all_emotions')
      await send(a,'你好')
      await send(a,'谢谢你的帮助，我很高兴认识你。')
      const get = () => ctx.storageDomain.get('dsh_affection').table('roles').get('standard')
      // The real DSH adapter returns model JSON and the installed plugin commits it.
      // Even an all-neutral valid vector has a small outward adjustment.
      for (let i=0; i<320 && get().axes.libidoOther.start === 25; i++) await delay(100)
      assert.equal(get().turns,2)
      assert.notEqual(get().axes.libidoOther.start,25, 'real analysis did not commit')
      assert.equal(analyses.length,0, 'analysis incorrectly used the fixture model')
      return
    }
    if (process.env.AFFECTION_SMOKE_RESTORE === '1') {
      assert.match(await cmd(a,'/mystatus'), /好感度：73\.0/)
      assert.match(await cmd(a,'/mystatus'), /有效互动轮数：3/)
      return
    }
    await cmd(a,'/reset_all_emotions')
    await send(a,'你好')
    assert.equal(chats.length,1, 'main request count ' + chats.map(c => c.messages.map(m => m.source?.kind).join(',')).join(' / '))
    assert.ok(JSON.stringify(chats[0].messages).includes('【角色情绪】'), 'missing first-turn context')
    assert.equal(analyses.length,0)
    assert.match(await cmd(a,'/mystatus'), /有效互动轮数：1/)
    const b = await agent('standard')
    await send(b,'谢谢')
    for (let i=0; i<80 && !(await cmd(b,'/mystatus')).includes('50.3'); i++) await delay(25)
    assert.match(await cmd(b,'/mystatus'), /好感度：50\.3/)
    assert.equal(analyses.length,1)
    assert.equal(chats.length,2)
    assert.match(analyses[0].messages[0].content[0].text, /谢谢/)
    askForTool = true
    await send(b,'工具测试')
    for (let i=0; i<80 && analyses.length<2; i++) await delay(25)
    assert.equal(chats.length,4)
    assert.equal(analyses.length,2)
    assert.match(await cmd(b,'/mystatus'), /有效互动轮数：3/)
    const context = call => call.messages.filter(m => m.source?.kind === 'runtime-context').at(-1)
    assert.deepEqual(context(chats[2]), context(chats[3]))
    await cmd(b,'/set_emotion affection=73 libidoOther=33')
    assert.match(await cmd(a,'/mystatus'), /好感度：73\.0/)
    await cmd(b,'/reset_current')
    await fiber.restart()
    assert.equal(ctx.commands.list(b).filter(d => d.name === 'mystatus').length,1)
    assert.match(await cmd(b,'/mystatus'), /好感度：73\.0/)
    for (const other of [await agent('minimal'), await agent('standard',true)]) {
      assert.ok(!ctx.commands.list(other).some(d => d.name === 'mystatus'))
      await send(other,'未启用')
      assert.ok(!JSON.stringify(chats.at(-1).messages).includes('【角色情绪】'))
    }
    await fiber.update({enabledPresets:[]},true)
    assert.equal(ctx.storageDomain.get('dsh_affection'),undefined)
    assert.ok(!ctx.commands.list(a).some(d => d.name === 'mystatus'))
  }
  // Yield the apply phase before creating a real AgentLoop and running commands.
  const timer = setTimeout(async () => {
    try {
      await run()
      for (const handle of handles.reverse()) await handle.dispose()
      console.log('AFFECTION_HOST_SMOKE_OK')
      process.exit(0)
    } catch (error) {
      console.error('AFFECTION_HOST_SMOKE_FAILED', error)
      process.exit(1)
    }
  }, 200)
  const deadline = setTimeout(() => { console.error('DSH smoke timed out'); process.exit(1) }, 45000)
  ctx.effect(() => () => { clearTimeout(timer); clearTimeout(deadline) })
}
