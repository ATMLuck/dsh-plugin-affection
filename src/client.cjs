const { createElement: h, useEffect, useRef, useState } = require('react')

const endpoint = '/api/affection/settings'
const labels = {
  affection: '好感度', libidoOther: '对用户的力比多', aggressionOther: '对用户的攻击性',
  libidoSelf: '自身力比多', aggressionSelf: '自身攻击性',
}
const css = `
.aff-chat{color:inherit;max-width:48rem;margin:0 auto;padding:12px 20px 28px;display:grid;gap:20px}
.aff-chat h2,.aff-chat h3,.aff-chat p,.aff-chat dl{margin:0}
.aff-chat h2{font-size:1.25rem}.aff-chat h3,.aff-chat legend{font-size:1rem;font-weight:600}
.aff-chat label,.aff-chat fieldset{min-width:0}.aff-chat fieldset{margin:0;padding:0;border:0}
.aff-chat textarea,.aff-chat select{box-sizing:border-box;width:100%;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:8px;font:inherit;color:inherit;background:var(--background,Canvas)}
.aff-chat textarea{min-height:8rem;resize:vertical}.aff-chat input{accent-color:Highlight}
.aff-chat .field{display:grid;gap:7px}.aff-chat .hint{font-size:.85rem;opacity:.74}
.aff-chat .checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:6px;margin-top:8px;max-height:14rem;overflow:auto}
.aff-chat .checks label{overflow-wrap:anywhere}
.aff-chat table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.aff-chat th,.aff-chat td{text-align:left;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent);padding:7px 6px}
.aff-chat input[type=number],.aff-chat input[type=text]{font:inherit;color:inherit;background:inherit;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:5px}
.aff-chat input[type=number]{width:5em;max-width:100%;box-sizing:border-box}
.aff-chat .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.aff-chat .heading{display:flex;gap:10px;align-items:center;justify-content:space-between}
.aff-chat button{border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:5px 12px;color:inherit}
.aff-chat button:disabled{opacity:.48}.aff-chat [role=alert]{color:var(--error-text,inherit);font-weight:550}
`
async function api(id, options = {}, edit) {
  const query = new URLSearchParams()
  if (id) query.set('preset', id)
  if (edit) query.set('edit', edit)
  const response = await fetch(endpoint + (query.size ? '?' + query : ''), { cache: 'no-store', ...options })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败。')
  return data
}
function post(id, value, edit) {
  return api(id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }, edit)
}

const resets = {
  'reset-current': '当前驱力恢复到基线',
  'reset-relationship': '重置关系与互动轮数',
  'reset-all': '重置全部情绪与互动轮数',
}

function EmotionTable({ id, emotion, onChange }) {
  const [draft, setDraft] = useState(null)
  const [notice, setNotice] = useState('')
  const [pending, confirm] = useState('')
  const [saving, setSaving] = useState(false)
  const changes = Object.entries(draft?.changes ?? {})
  const valid = changes.length > 0 && changes.every(([key, str]) =>
    str.trim() && Number.isFinite(Number(str)) && Number(str) >= 0 && Number(str) <= (key === 'affection' ? 100 : 50))
  const stale = !!draft && draft.epoch !== (emotion?.epoch ?? 0)
  async function submit(action) {
    setSaving(true)
    try {
      const values = Object.fromEntries(changes.map(([key, str]) => [key, Number(str)]))
      const saved = await post(id, { action, epoch: draft.epoch, ...(action === 'set' ? { values } : {}) }, 'emotion')
      onChange(saved)
      setDraft(null)
      setNotice('已更新情感档案。')
    } catch (error) { setNotice(error.message) }
    finally { setSaving(false); confirm('') }
  }
  return h('section', { className: 'field' },
    h('h3', null, '当前情感数值'),
    h('p', { className: 'hint' }, emotion
      ? `对你的情感 ${emotion.towards}　自身状态 ${emotion.self}　互动 ${emotion.turns} 轮` : '暂无情绪档案'),
    h('table', null,
      h('thead', null, h('tr', null, ['项目', '当前值', '基线'].map(title => h('th', { key: title, scope: 'col' }, title)))),
      h('tbody', null, Object.entries(labels).map(([key, label]) => h('tr', { key },
        h('th', { scope: 'row' }, label),
        h('td', null, draft ? h('input', {
          'aria-label': label, type: 'number', min: 0, max: key === 'affection' ? 100 : 50, step: 'any', disabled: saving,
          value: draft.changes[key] ?? draft.values?.[key]?.toFixed(1) ?? '',
          onChange: e => {
            const value = e.target.value
            setDraft(previous => ({ ...previous, changes: { ...previous.changes, [key]: value } }))
            setNotice('')
          },
        }) : emotion?.values[key]?.toFixed(1) ?? '—'),
        h('td', null, emotion?.baseline[key]?.toFixed(1) ?? '—'))))),
    h('label', null, h('input', { type: 'checkbox', role: 'switch', checked: !!draft, disabled: saving, onChange: e => {
      confirm('')
      setNotice('')
      setDraft(e.target.checked ? { epoch: emotion?.epoch ?? 0, values: emotion?.values, changes: {} } : null)
    } }), ' 允许编辑情感数值'),
    draft && h('p', { className: 'hint' }, '好感度范围 0–100，驱力范围 0–50。保存后，驱力从新数值向原基线回归。'),
    stale && h('p', { role: 'alert' }, '档案已在其他窗口修改。请重新打开编辑开关。'),
    draft && h('div', { className: 'actions' },
      h('button', { type: 'button', disabled: saving || stale || !valid, onClick: () => submit('set') }, '保存情感数值'),
      Object.entries(resets).map(([action, label]) =>
        h('button', { key: action, type: 'button', disabled: saving || stale || !emotion, onClick: () => confirm(action) }, label))),
    pending && h('div', { className: 'actions' }, h('p', null, `确认${resets[pending]}？`),
      h('button', { type: 'button', disabled: saving || stale, onClick: () => submit(pending) }, '确认重置'),
      h('button', { type: 'button', disabled: saving, onClick: () => confirm('') }, '取消')),
    notice && h('p', { role: 'status' }, notice))
}

function ChatSettings() {
  const [rows, setRows] = useState([])
  const [id, select] = useState('')
  const [detail, setDetail] = useState(null)
  const [drafts, setDrafts] = useState(new Map())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [newName, setNewName] = useState(null)
  const [createError, setCreateError] = useState('')
  const refreshRef = useRef(() => {})
  const draft = drafts.get(id)
  const selected = rows.find(row => row.id === id)
  const data = detail?.id === id ? detail : null
  const value = draft ?? data?.settings
  const conflict = !!draft && !!data && draft.revision !== data.settings.revision

  useEffect(() => {
    let active = true
    let sequence = 0
    const abort = new AbortController()
    async function refresh() {
      if (document.hidden) return
      const seq = ++sequence
      try {
        const rows = await api('', { signal: abort.signal })
        if (!active || seq !== sequence) return
        setRows(rows)
        if (!id || !rows.some(row => row.id === id)) {
          select(rows[0]?.id ?? '')
          setDetail(null)
          return
        }
        const next = await api(id, { signal: abort.signal })
        if (active && seq === sequence) { setDetail({ ...next, id }); setError('') }
      } catch (err) {
        if (active && seq === sequence) setError(err.message)
      }
    }
    refreshRef.current = refresh
    const timer = setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    refresh()
    return () => {
      active = false
      abort.abort()
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [id])

  function edit(patch) {
    setDrafts(previous => new Map(previous).set(id, { ...(previous.get(id) ?? value), ...patch }))
    setNotice('')
  }
  function discard() {
    setDrafts(previous => { const next = new Map(previous); next.delete(id); return next })
    setNotice('')
    refreshRef.current()
  }
  async function save() {
    setSaving(true)
    try {
      const settings = await post(id, value)
      setDetail(previous => previous?.id === id ? { ...previous, settings } : previous)
      setDrafts(previous => { const next = new Map(previous); next.delete(id); return next })
      setNotice('已保存。')
    } catch (err) { setNotice(err.message) }
    finally { setSaving(false); refreshRef.current() }
  }
  async function createPreset(event) {
    event.preventDefault()
    setSaving(true)
    setCreateError('')
    try {
      const created = await post('', { name: newName }, 'preset')
      setRows(previous => [...previous.filter(row => row.id !== created.id), created])
      setNewName(null)
      select(created.id)
      setNotice('')
      setError('')
    } catch (error) { setCreateError(error.message) }
    finally { setSaving(false) }
  }
  const tools = [...new Set([...(data?.tools ?? []), ...(value?.tools ?? [])])]
  return h('section', { className: 'aff-chat' },
    h('style', null, css), h('h2', null, '情感聊天'),
    h('label', { className: 'field' }, '角色预设',
      h('select', { value: id, disabled: saving, onPointerDown: () => refreshRef.current(),
        onKeyDown: e => { if (['ArrowDown','Enter',' '].includes(e.key)) refreshRef.current() },
        onChange: e => { select(e.target.value); setNotice(''); setError('') } },
        rows.map(row => h('option', { key: row.id, value: row.id },
          row.name + ' · ' + row.id + (row.broken ? ' · 加载失败' : row.enabled ? ' · 已接管' : ' · 未接管'))))),
    error && h('p', { role: 'alert' }, error),
    selected?.broken && h('p', { role: 'alert' }, selected.broken),
    !id && h('p', null, '暂无可选预设。'),
    value && data && h('div', { className: 'field' },
      h('label', null, h('input', { type: 'checkbox', checked: value.enabled, disabled: saving || (!!data.broken && !value.enabled),
        onChange: e => edit({ enabled: e.target.checked }) }), ' 接管此预设'),
      h('p', { className: 'hint' }, '启停接管在新建或重新加载会话后生效。人格和工具修改从已接管聊天的下一轮生效。')),
    h('div', { className: 'field' },
      h('div', { className: 'heading' },
        h('label', { htmlFor: 'affection-persona' }, '人格提示词'),
        h('button', { type: 'button', disabled: saving, onClick: () => { setNewName(''); setCreateError('') } }, '新建预设')),
      newName !== null && h('form', { className: 'field', onSubmit: createPreset },
        h('label', { className: 'field' }, '预设名称', h('input', { type: 'text', value: newName, maxLength: 80, required: true,
          disabled: saving, onChange: e => setNewName(e.target.value) })),
        h('div', { className: 'actions' },
          h('button', { type: 'submit', disabled: saving || !newName.trim() }, '创建预设'),
          h('button', { type: 'button', disabled: saving, onClick: () => setNewName(null) }, '取消')),
        createError && h('p', { role: 'alert' }, createError)),
      value && data && h('textarea', { id: 'affection-persona', value: value.persona, disabled: saving,
        onChange: e => edit({ persona: e.target.value }) })),
    value && data && h('fieldset', { disabled: saving },
      h('legend', null, '允许的工具'),
      tools.length ? h('div', { className: 'checks' }, tools.map(name =>
        h('label', { key: name }, h('input', { type: 'checkbox', checked: value.tools.includes(name),
          disabled: !data.tools.includes(name) && !value.tools.includes(name),
          onChange: e => edit({ tools: e.target.checked ? [...value.tools, name] : value.tools.filter(t => t !== name) }) }),
          ' ' + name + (data.tools.includes(name) ? '' : '（当前不可用）')))) : h('p', { className: 'hint' }, '此预设暂无工具。')),
    value && data && h('div', { className: 'actions' },
      h('button', { type: 'button', disabled: saving || !draft || conflict || (value.enabled && (!value.persona.trim() || !!data.broken)),
        onClick: save }, saving ? '保存中…' : '保存设置'),
      draft && h('button', { type: 'button', disabled: saving, onClick: discard }, conflict ? '丢弃草稿并重新载入' : '撤销修改'),
      h('span', { role: 'status' }, notice || (draft ? '有未保存的修改' : ''))),
    conflict && h('p', { role: 'alert' }, '其他窗口已更新此预设。当前草稿已保留。'),
    data && h(EmotionTable, { key: id, id, emotion: data.emotion, onChange: emotion => {
      setDetail(previous => previous?.id === id ? { ...previous, emotion } : previous)
      refreshRef.current()
    } }))
}
exports.inject = ['slots']
exports.apply = ctx => {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'affection', order: 81, label: () => '情感聊天',
  }, ChatSettings))
}
