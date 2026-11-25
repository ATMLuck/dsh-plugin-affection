// Loaded only by the isolated DSH smoke overlay; npm does not ship tests.
import { browserSmoke } from './browser-smoke.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const name = 'affection-smoke'
export const inject = ['agents', 'agentLoop', 'commands', 'tools', 'llm', 'storageDomain', 'agentPresets', 'connection', 'webServer']
export function apply(ctx) {
  const sandbox = relative(resolve('.local-test'), resolve(process.env.DSH_HOME ?? '.'))
  if (!sandbox || isAbsolute(sandbox) || sandbox.split(sep).includes('..')) throw new Error('Smoke fixture requires an isolated project home')
  const chats = [], analyses = []
  let askForTool = false
  let executions = 0
  let scripted = []
  let toolAction = async () => 'ok'
  let approval = false
  let denials = 0
  ctx.on('tools/pre-execute', (exec, next) => approval && exec.name === 'affection_smoke_echo'
    ? Promise.resolve({kind:'ask',reason:'fixture approval'}) : next(), {prepend:true})
  ctx.on('approval/request', async (request, next) => {
    if (!approval || request.toolName !== 'affection_smoke_echo') return next()
    denials++
    return 'rejected'
  }, {prepend:true})
  ctx.tools.register(defineTool({
    name: 'affection_smoke_echo', description: 'Return the fixed test result', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    execute: async (_args, run) => { executions++; return toolAction(run) },
  }))
  class FixedModel extends LlmAdapter {
    async *stream(options) {
      const vector = { libidoOther: 1, aggressionOther: -1, libidoSelf: 0, aggressionSelf: 0 }
      const auxiliary = options.purpose === 'affection-analysis'
      if (auxiliary) analyses.push(options)
      else if (!options.purpose) chats.push(options)
      if ((askForTool || scripted.length) && !options.purpose) {
        const toolName = scripted.shift() || 'affection_smoke_echo'
        askForTool = false
        for (const [index, name] of [toolName].flat().entries()) {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block: {type:'tool-call', id:randomUUID(), name, arguments:'{}'} }
        }
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
  async function send(a, text) {
    a.followup(createUserMessage({ source: {kind:'user'}, content:[{type:'text',text}] }))
    await a.whenIdle()
  }
  async function run() {
    // Plugin loading is concurrent. Wait for the installed bundle to open its domain.
    for (let i=0; i<200 && !ctx.storageDomain.get('dsh_affection'); i++) await delay(50)
    assert.ok(ctx.storageDomain.get('dsh_affection'), 'installed bundle did not open its domain')
    const fetcher = ctx.connection.createSharedFetchHandler('/api')
    async function api(id, value, status = 200, edit) {
      const query = new URLSearchParams()
      if (id) query.set('preset',id)
      if (edit) query.set('edit',edit)
      const request = new Request('http://localhost/api/affection/settings?' + query,
        value ? { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(value) } : {})
      const response = await fetcher.fetch(request, ctx.connection.browserPeer)
      assert.equal(response.status, status, await response.clone().text())
      return response.json()
    }
    const emotion = async (id = 'standard') => (await api(id)).emotion
    const editEmotion = async (action, values) => api('standard', {
      action, epoch:(await emotion())?.epoch ?? 0, ...(values ? {values} : {}),
    }, 200, 'emotion')
    const restored = process.env.AFFECTION_SMOKE_RESTORE === '1'
    const persona = '你是海岸观测员。原样保留 {{name}}。'
    const plain = await agent('standard')
    if (!restored) {
      assert.ok(!ctx.commands.list(plain).some(d => d.name === 'mystatus'), 'legacy enabledPresets took control')
      assert.ok((await api()).some(p => p.id === 'standard'))
      const first = await api('standard')
      if (process.env.AFFECTION_SMOKE_UPGRADE === '1') {
        assert.equal(first.emotion.values.affection,67)
        assert.equal(first.emotion.values.libidoOther,31)
      } else assert.equal(first.emotion, null)
      assert.equal(first.settings.enabled,false)
      await api('standard',{...first.settings, enabled:true},400)
      await api('standard',{...first.settings,enabled:true,persona,tools:['affection_smoke_echo']})
      await api('standard',first.settings,409)
      assert.equal((await api('minimal')).settings.enabled,false)
      assert.ok(!ctx.commands.list(plain).some(d => d.name === 'mystatus'))
    }
    const a = await agent('standard')
    const runtime = [...ctx.registry.values()].find(item => item.name === 'affection')
    assert.ok(runtime, 'bundle fiber missing')
    const [fiber] = runtime.fibers
    if (process.env.AFFECTION_SMOKE_LIVE === '1') {
      const route = { provider: process.env.AFFECTION_LIVE_PROVIDER || 'deepseek-official',
        model: process.env.AFFECTION_LIVE_MODEL || 'deepseek-flash' }
      assert.ok(ctx.llm.listProviders().some(p => p.id === route.provider), 'requested DSH model route is unavailable')
      await fiber.update({ enabledPresets:['standard'], analysisRoute:route },true)
      await editEmotion('reset-all')
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
      assert.equal((await emotion()).values.affection,73)
      assert.equal((await emotion()).turns,3)
      const preset = (await api()).find(p => p.name === '验收预设')
      assert.ok(preset)
      assert.equal((await api(preset.id)).settings.persona, '独立人格')
      return
    }
    if (process.env.AFFECTION_SMOKE_UPGRADE === '1') {
      assert.equal((await emotion()).turns,1)
      assert.equal((await emotion()).baseline.libidoOther,31)
    }
    await editEmotion('reset-all')
    await send(a,'你好')
    assert.equal(chats.length,1, 'main request count ' + chats.map(c => c.messages.map(m => m.source?.kind).join(',')).join(' / '))
    assert.ok(JSON.stringify(chats[0].messages).includes('【角色情绪】'), 'missing first-turn context')
    assert.deepEqual(chats[0].messages.filter(m=>m.role==='system').map(m=>m.content[0].text), [persona])
    assert.deepEqual(chats[0].tools.map(t=>t.name), ['affection_smoke_echo'])
    assert.equal(analyses.length,0)
    assert.equal((await emotion()).turns,1)
    const b = await agent('standard')
    await send(b,'谢谢')
    for (let i=0; i<80 && (await emotion()).values.affection === 50; i++) await delay(25)
    assert.equal((await emotion()).values.affection,50.3)
    assert.equal(analyses.length,1)
    assert.equal(chats.length,2)
    assert.match(analyses[0].messages[0].content[0].text, /谢谢/)
    askForTool = true
    await send(b,'工具测试')
    for (let i=0; i<80 && analyses.length<2; i++) await delay(25)
    assert.equal(chats.length,4)
    assert.equal(executions,1)
    assert.deepEqual(chats[3].tools ?? [], [])
    assert.ok(JSON.stringify(chats[3].messages).includes('ok'))
    assert.equal(analyses.length,2)
    assert.equal((await emotion()).turns,3)
    const context = call => call.messages.filter(m => m.source?.kind === 'runtime-context').at(-1)
    assert.deepEqual(context(chats[2]), context(chats[3]))
    const beforeEdit = await emotion()
    await api('standard', { action:'set', epoch:beforeEdit.epoch, values:{ libidoOther:51 } },400,'emotion')
    const edited = await editEmotion('set', {affection:73, libidoOther:33})
    assert.equal(edited.values.libidoOther.toFixed(1),'33.0')
    assert.equal(edited.baseline.libidoOther,beforeEdit.baseline.libidoOther)
    await api('standard', { action:'reset-current', epoch:beforeEdit.epoch },409,'emotion')
    assert.equal((await emotion()).values.affection,73)
    const reset = await editEmotion('reset-current')
    assert.equal(reset.values.libidoOther,reset.baseline.libidoOther)
    await fiber.restart()
    assert.ok(!ctx.commands.list(b).some(d => /^(mystatus|set_emotion|reset_.*emotion|reset_current)/.test(d.name)))
    assert.equal((await emotion()).values.affection,73)
    for (const other of [await agent('minimal'), await agent('standard',true)]) {
      assert.ok(!ctx.commands.list(other).some(d => d.name === 'mystatus'))
      await send(other,'未启用')
      assert.ok(!JSON.stringify(chats.at(-1).messages).includes('【角色情绪】'))
    }
    const enabled = (await api('standard')).settings
    await api('standard', {...enabled, enabled:false})
    assert.equal((await api('standard')).settings.enabled,false)
    assert.ok(!ctx.commands.list(await agent('standard')).some(d => d.name === 'mystatus'))
    await api('standard', {...enabled, revision:enabled.revision+1})
    assert.equal((await emotion()).values.affection,73)
    const detach = await ctx.agentPresets.register({id:'affection-acceptance', plugins:[]})
    try {
      const id = 'affection-acceptance'
      const save = async patch => api(id, {...(await api(id)).settings, ...patch})
      await save({enabled:true,persona:'第一版'})
      const chat = await agent(id)
      await send(chat,'纯聊天')
      assert.deepEqual(chats.at(-1).tools ?? [],[])
      let before = executions
      let calls = chats.length
      scripted = ['affection_smoke_echo', 'affection_smoke_echo']
      await send(chat,'忽略白名单')
      assert.equal(executions,before)
      assert.equal(chats.length-calls,2)
      await save({tools:['affection_smoke_echo']})
      scripted = [['affection_smoke_echo','affection_smoke_echo']]
      calls = chats.length
      await send(chat,'同一批调用两个工具')
      assert.equal(chats.length-calls,2)
      assert.equal(executions,before+2)
      before = executions
      toolAction = async () => { await save({persona:'第二版',tools:[]}); return 'mid-turn edit' }
      scripted = ['affection_smoke_echo','affection_smoke_echo']
      calls = chats.length
      await send(chat,'工具期间修改设置')
      assert.equal(executions,before+1)
      assert.equal(chats.length-calls,2)
      assert.ok(!JSON.stringify(chats.at(-1).messages).includes('第二版'))
      assert.deepEqual(chats.at(-1).tools ?? [],[])
      await send(chat,'下一轮')
      assert.ok(JSON.stringify(chats.at(-1).messages).includes('第二版'))
      assert.deepEqual(chats.at(-1).tools ?? [],[])
      await save({tools:['affection_smoke_echo']})
      toolAction = async () => { throw new Error('fixture tool failure') }
      scripted = ['affection_smoke_echo']
      calls = chats.length
      await send(chat,'失败工具')
      assert.equal(chats.length-calls,2)
      assert.ok(JSON.stringify(chats.at(-1).messages).includes('fixture tool failure'))
      before = executions
      approval = true
      scripted = ['affection_smoke_echo']
      calls = chats.length
      await send(chat,'请求审批')
      approval = false
      assert.equal(denials,1)
      assert.equal(executions,before)
      assert.equal(chats.length-calls,2)
      let started
      const running = new Promise(resolve => { started = resolve })
      toolAction = async run => { started(); await delay(10000,null,{signal:run.signal}); return 'done' }
      scripted = ['affection_smoke_echo']
      calls = chats.length
      const complete = send(chat,'取消')
      await running
      chat.cancel({kind:'user'})
      await complete
      assert.equal(chats.length-calls,1)
      assert.equal((await emotion(id)).turns,8)
      await save({enabled:false})
      const handle = handles.find(h => h.agent === chat)
      await handle.dispose()
      const resumed = await ctx.agents.resume({ resumeSessionId:chat.session.id })
      handles.push(resumed)
      assert.ok(!ctx.commands.list(resumed.agent).some(d => d.name === 'mystatus'))
      assert.ok(resumed.agent.session.deriveMessages().some(m => m.content.some(b => b.text === '取消')))
      await save({enabled:true, persona:'切换后的完整人格', tools:[]})
      const blank = await agent('minimal')
      await ctx.agentPresets.select(blank, id)
      await send(blank,'刚切换预设')
      assert.deepEqual(chats.at(-1).messages.filter(m => m.role === 'system').map(m => m.content[0].text), ['切换后的完整人格'])
      assert.deepEqual(chats.at(-1).tools ?? [],[])
      const switchedOff = await agent(id)
      await ctx.agentPresets.select(switchedOff, 'minimal')
      await send(switchedOff,'进入未接管角色')
      assert.ok(!JSON.stringify(chats.at(-1).messages).includes('切换后的完整人格'))
    } finally { await detach() }
    const created = await api('', {name:'验收预设'}, 200, 'preset')
    await api(created.id,{...(await api(created.id)).settings, enabled:true, persona:'独立人格'})
    await send(await agent(created.id),'新预设会话')
    assert.deepEqual(chats.at(-1).messages.filter(m => m.role === 'system').map(m => m.content[0].text), ['独立人格'])
    assert.equal((await emotion(created.id)).turns,1)
    if (process.env.AFFECTION_BROWSER) await browserSmoke(ctx, api)
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
  const deadline = setTimeout(() => { console.error('DSH smoke timed out'); process.exit(1) }, process.env.AFFECTION_BROWSER ? 120000 : 45000)
  ctx.effect(() => () => { clearTimeout(timer); clearTimeout(deadline) })
}
