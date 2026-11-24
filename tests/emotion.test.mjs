import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDeltas, blend, current, defaults, describe, edit, hour, makeProfile } from '../src/emotion.ts'
import { relationshipTables } from '../src/tables.ts'
import { Config } from '../src/schema.ts'
import { parseDeltas } from '../src/analysis.ts'

test('configuration allows the conversation route and rejects an incomplete custom route', () => {
  assert.deepEqual(Config({}).enabledPresets, [])
  assert.equal(Config({}).analysisRoute, undefined)
  assert.throws(() => Config({ analysisRoute: { provider: 'demo' } }))
  assert.throws(() => Config({ lockTurns: 0 }))
})
test('canonical labels, affection boundaries and interpolated corners', () => {
  const p = makeProfile(defaults, false, 0)
  for (const [affection, towards] of [[0,'轻蔑'],[12.5,'竞争'],[50,'竞争'],[62.49,'竞争'],[62.5,'争宠'],[75,'争宠'],[100,'撒娇争夺']]) {
    const got = describe({ ...p, affection }, 0, defaults)
    assert.equal(got.towards, towards)
    assert.equal(got.self, '内疚')
  }
  assert.equal(blend(relationshipTables[2], 25, 6.25), '喜欢(50%)/渴望(50%)')
})
test('first impressions, small zero response and bounded updates match source rules', () => {
  const p = makeProfile(defaults, false, 0)
  const huge = { libidoOther: 99, aggressionOther: -99, libidoSelf: 99, aggressionSelf: -99 }
  const delta = { current: huge, base: huge, affection: 99, intensity: 9 }
  const early = applyDeltas(p, delta, 10, 0, defaults, false)
  assert.equal(early.axes.libidoOther.base, 26.5)
  assert.equal(early.axes.libidoSelf.base, 25.04)
  assert.equal(early.affection, 50.6)
  assert.equal(early.axes.libidoOther.start, 25.6)
  const late = applyDeltas(p, delta, 11, 0, defaults, false)
  assert.equal(late.axes.libidoOther.base, 25.04)
  assert.equal(late.axes.aggressionOther.base, 24.96)
  assert.throws(() => parseDeltas('{"current":{}}'))
  assert.throws(() => parseDeltas('not JSON'))
})
test('quadratic decay has a fixed midpoint and deadline even across restart', () => {
  const axis = { start: 35, base: 25, since: hour }
  assert.equal(current(axis, 0, 2), 35)
  assert.equal(current(axis, 2*hour, 2), 32.5)
  assert.equal(current(structuredClone(axis), 3*hour, 2), 25)
  assert.equal(current(axis, 10*hour, 2), 25)
})
test('set and three resets have distinct effects', () => {
  const init = makeProfile(defaults, true, 0)
  const manual = edit(init, 'set_emotion', 'affection=73 libidoOther=17 aggressionSelf=41', defaults, true, 1)
  assert.equal(manual.affection, 73)
  assert.equal(manual.axes.aggressionSelf.base, 41)
  assert.throws(() => edit(manual,'set_emotion','affection=44 unknown=2', defaults, true, 1))
  manual.axes.libidoOther = { start: 30, base: 17, since: 0 }
  assert.equal(edit(manual,'reset_current','', defaults,true,2).axes.libidoOther.start,17)
  const relation = edit(manual,'reset_emotion','', defaults,true,2)
  assert.equal(relation.affection,100)
  assert.equal(relation.axes.aggressionSelf.start,41)
  assert.equal(edit(manual,'reset_all_emotions','', defaults,true,2).axes.aggressionSelf.start,25)
})
