import assert from 'node:assert/strict'
import test from 'node:test'
import { defaults, makeProfile } from '../src/emotion.ts'
import { PresetSettings } from '../src/settings.ts'

function fixture() {
  const records = new Map()
  const profiles = new Map()
  const presets = [{ id: 'coast' }, { id: 'forest' }, { id: 'broken', broken: '无法加载' }]
  const ctx = {
    agentPresets: {
      list: async () => presets,
      acquireScope: async id => ({ key: id, async [Symbol.asyncDispose]() {} }),
    },
    tools: { definitions: id => id === 'coast' ? [{ name: 'search' }] : [] },
  }
  const store = new PresetSettings(ctx, {
    get: id => records.get(id),
    put: async (id, value) => { records.set(id, value) },
  }, id => profiles.get(id), defaults)
  return { store, profiles, records }
}

test('reading all roles and their current values does not initialize settings or profiles', async () => {
  const { store, profiles, records } = fixture()
  assert.deepEqual((await store.roster()).map(row => row.enabled), [false,false,false])
  assert.deepEqual((await store.detail('coast')).tools, ['search'])
  assert.equal((await store.detail('forest')).values, null)
  assert.equal(records.size + profiles.size, 0)
  const state = makeProfile(defaults, false, Date.now())
  profiles.set('coast', state)
  assert.deepEqual((await store.detail('coast')).values, {affection:50, ...defaults.initialDrives})
  assert.equal(state.turns, 0)
})

test('competing saves check the same revision inside the write queue and isolate roles', async () => {
  const { store } = fixture()
  const draft = { enabled:true, persona:'{{literal}}', tools:['search'], revision:0 }
  const [first, second] = await Promise.allSettled([store.save('coast',draft), store.save('coast',draft)])
  assert.equal(first.value.revision, 1)
  assert.equal(second.reason.status, 409)
  await assert.rejects(store.save('forest',draft), {status:400})
  await assert.rejects(store.save('forest',{...draft,tools:[],persona:'   '}), {status:400})
  await assert.rejects(store.save('broken',{...draft,tools:[]}), /无法加载/)
  await assert.rejects(store.save('removed',draft), {status:404})
  assert.equal(store.get('forest').revision, 0)
  assert.equal(store.get('coast').persona, '{{literal}}')
  await store.close()
  assert.throws(() => store.save('coast',draft), {status:503})
})
