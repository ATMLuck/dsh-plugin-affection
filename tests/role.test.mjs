import test from 'node:test'
import assert from 'node:assert/strict'
import { Role } from '../src/role.ts'
import { hour, makeProfile } from '../src/emotion.ts'
import { Config } from '../src/schema.ts'

const route = { provider: 'offline', model: 'fixed' }
const input = { latest: '谢谢', history: '' }
const vector = { libidoOther: 1, aggressionOther: -1, libidoSelf: 0, aggressionSelf: 0 }
const delta = { current: vector, base: vector, affection: 1, intensity: 1 }
function setup(analyze = async () => delta) {
  const cfg = Config({})
  const rows = new Map([['a',makeProfile(cfg,false,0)]])
  let clock = 0
  const store = { get: key => rows.get(key), put: async (key, v) => rows.set(key,structuredClone(v)) }
  const open = () => new Role('a',store,cfg,analyze,() => {},() => clock)
  const role = open()
  const send = async (sid, turn) => role.admit(sid,turn,route,input,await role.preview(sid,turn))
  return { role, send, open, state: () => rows.get('a'), time: n => { clock = n } }
}
test('concurrent chats are both recorded, retries deduplicate, lock lasts five human turns', async () => {
  let calls = 0
  const { role, send, state, open } = setup(async () => { calls++; return delta })
  const initial = await role.preview('a',1)
  await Promise.all([send('a',1),send('a',1),send('b',1)])
  await role.settle()
  assert.equal(state().turns,2)
  assert.equal(calls,1)
  for (let i = 2; i <= 4; i++) {
    assert.equal(await role.preview('a',i), initial)
    await send('a',i)
    await role.settle()
  }
  assert.notEqual(await role.preview('a',5), initial)
  assert.equal(await role.preview('a',4), initial)
  await role.close()
  const restored = open()
  await restored.admit('a',4,route,input,initial)
  assert.equal(state().turns,5)
  await restored.close()
})
test('late analysis cannot overwrite manual update or reset; next round refreshes', async () => {
  const entered = Promise.withResolvers(), finished = Promise.withResolvers()
  const { role, send, state } = setup(async () => { entered.resolve(); return finished.promise })
  await send('a',1)
  await send('a',2)
  await entered.promise
  await role.command('reset_all_emotions','')
  await role.command('set_emotion','affection=81')
  finished.resolve(delta)
  await role.settle()
  assert.equal(state().affection,81)
  assert.equal(state().turns,0)
  assert.match(await role.preview('a',3), /81\.0/)
  await send('a',2)
  assert.equal(state().turns,0)
  await role.close()
})
test('idle is claimed once per interval and survives restart', async () => {
  let calls = 0
  const { role, send, state, time, open } = setup(async () => { calls++; return delta })
  await send('a',1)
  time(6*hour)
  await Promise.all([role.idle(),role.idle()])
  await role.settle()
  assert.equal(calls,1)
  assert.equal(state().affection,50)
  assert.equal(state().axes.libidoOther.start,25.3)
  await role.close()
  const restored = open()
  await restored.idle()
  await restored.settle()
  assert.equal(calls,1)
  await restored.admit('a',2,route,input,'prior')
  await restored.settle()
  time(13*hour)
  await restored.idle()
  await restored.settle()
  assert.equal(calls,3)
  await restored.close()
})
test('fresh interaction invalidates a pending idle result', async () => {
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const { role, send, state, time } = setup(async request => {
    if (request.interaction) return delta
    entered.resolve()
    return finish.promise
  })
  await send('s',1)
  time(7 * hour)
  await role.idle()
  await entered.promise
  await send('s',2)
  finish.resolve(delta)
  await role.settle()
  assert.equal(state().axes.libidoOther.start, 25.3)
  assert.equal(state().idleChecked, false)
  await role.close()
})
test('an aborted originating turn suppresses the background model update', async () => {
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const control = new AbortController()
  const { role, send, state } = setup(async () => { entered.resolve(); return finish.promise })
  await send('s',1)
  await role.admit('s',2,route,input,'snapshot',control.signal)
  await entered.promise
  control.abort()
  finish.resolve(delta)
  await role.settle()
  assert.equal(state().turns,2)
  assert.equal(state().affection,50)
  await role.close()
})
test('invalid model output leaves numbers intact, unload aborts pending analysis', async () => {
  const entered = Promise.withResolvers()
  let count = 0
  const { role, send, state } = setup(async (_, signal) => {
    if (++count === 1) throw new Error()
    entered.resolve()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once:true }))
  })
  await send('s',1); await send('s',2); await role.settle()
  assert.equal(state().affection,50)
  await send('s',3); await entered.promise
  await role.close()
  assert.equal(state().affection,50)
})
