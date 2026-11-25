import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Drive the installed browser against the packed profile using its local DevTools port.
async function until(read, message, timeout = 12000) {
  const deadline = Date.now() + timeout
  do {
    const value = await read()
    if (value) return value
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error(message)
}

export async function browserSmoke(ctx, api) {
  const profile = await mkdtemp(join(process.env.DSH_HOME, 'browser-'))
  const chrome = spawn(process.env.AFFECTION_BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' })
  let socket, removePreset, removeEditor
  const editor = 'affection-browser-editor'
  try {
    removeEditor = await ctx.agentPresets.register({id:editor, plugins:[]})
    const port = await until(async () => {
      if (chrome.exitCode !== null) throw new Error('Browser exited with code ' + chrome.exitCode)
      try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch { return false }
    }, 'Browser startup failed')
    const [tab] = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).filter(t => t.type === 'page')
    console.log('Browser debugging connection ready')
    socket = new WebSocket(tab.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser WebSocket timed out')), 8000)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Browser WebSocket failed')) }
    })
    let id = 0
    const pending = new Map()
    socket.onmessage = event => {
      const result = JSON.parse(event.data)
      if (result.id) {
        const job = pending.get(result.id)
        pending.delete(result.id)
        if (!job) return
        if (result.error) job.reject(new Error(result.error.message))
        else job.resolve(result.result)
      }
    }
    const call = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('Browser command timed out: ' + method)) }, 8000)
      pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject: error => { clearTimeout(timeout); reject(error) } })
      socket.send(JSON.stringify({ method, params, id }))
    })
    async function evaluate(expression) {
      const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'Browser evaluation failed')
      return out.result.value
    }
    const click = expression => evaluate('(' + expression + ')?.click()')
    const has = expression => until(() => evaluate(expression), 'Missing control: ' + expression)
    console.log('Opening isolated settings page')
    await call('Page.navigate', { url: ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()) })
    await has(`!!document.querySelector('button[aria-label="账号菜单"],button[aria-label="Account menu"]')`)
    let lastShortcut = 0
    await until(async () => {
      const action = await evaluate(`{
        const dialog = [...document.querySelectorAll('button')].find(b =>
          /^(继续|跳过|稍后|完成|Continue|Skip|Finish)$/.test(b.textContent.trim()) && b.getClientRects().length)
        const link = [...document.querySelectorAll('button,[role=tab],span')].find(b =>
          b.textContent.trim()==='情感聊天' && b.getClientRects().length)
        if (dialog) dialog.click()
        else link?.click()
        dialog ? 'onboarding' : link ? 'opened' : 'ready'
      }`)
      if (action === 'opened') return true
      if (action === 'onboarding') lastShortcut = 0
      if (action === 'ready' && Date.now()-lastShortcut > 1500) {
        lastShortcut = Date.now()
        await call('Input.dispatchKeyEvent', {type:'keyDown',key:',',code:'Comma',modifiers:3,windowsVirtualKeyCode:188})
        await call('Input.dispatchKeyEvent', {type:'keyUp',key:',',code:'Comma',modifiers:3,windowsVirtualKeyCode:188})
      }
      return false
    }, 'Settings navigation missing').catch(async err => {
      throw new Error(err.message + ' ' + await evaluate("document.body.innerText.slice(0,1100)"))
    })
    await has("!!document.querySelector('.aff-chat textarea')")
    const page = "document.querySelector('.aff-chat')"
    const select = id => evaluate(`{const s=${page}.querySelector('select');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));}`)
    const edit = text => evaluate(`{const t=${page}.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}))}`)
    const button = label => `[...${page}.querySelectorAll('button')].find(b=>b.textContent==='${label}')`
    console.log('Settings page mounted')
    await select(editor)
    await has(page + ".innerText.includes('暂无情绪档案')")
    await edit('草稿 {{literal}}')
    await click(page + ".querySelector('input[type=checkbox]')")
    await click(`[...${page}.querySelectorAll('label')].find(label=>label.textContent.trim()==='affection_smoke_echo').querySelector('input')`)
    removePreset = await ctx.agentPresets.register({id:'affection-browser-temp', name:'页面测试', plugins:[]})
    await has(page + ".querySelector('option[value=affection-browser-temp]') !== null")
    assert.equal(await evaluate(page + ".querySelector('textarea').value"), '草稿 {{literal}}')
    await removePreset()
    removePreset = undefined
    await has(page + ".querySelector('option[value=affection-browser-temp]') === null")
    await click(button('保存设置'))
    await until(async () => (await api(editor)).settings.persona === '草稿 {{literal}}', 'Browser save failed')
    assert.equal((await api(editor)).settings.enabled, true)
    assert.deepEqual((await api(editor)).settings.tools, ['affection_smoke_echo'])
    await edit('并发编辑草稿')
    const old = (await api(editor)).settings
    await api(editor, {...old, persona:'其他窗口'})
    await has(page + ".innerText.includes('当前草稿已保留')")
    assert.equal(await evaluate(page + ".querySelector('textarea').value"), '并发编辑草稿')
    await click(button('丢弃草稿并重新载入'))
    await select('standard')
    await has(page + ".querySelector('dd')?.textContent === '73.0'")
    assert.equal(await evaluate(page + ".querySelectorAll('dd').length"), 5)
    console.log('AFFECTION_BROWSER_SMOKE_OK')
  } finally {
    if (removePreset) await removePreset()
    if (removeEditor) await removeEditor()
    socket?.close()
    chrome.kill()
  }
}
