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
.aff-chat .checks label{overflow-wrap:anywhere}.aff-chat dl>div{display:flex;justify-content:space-between;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent);padding:6px 0}
.aff-chat dd{font-variant-numeric:tabular-nums}.aff-chat .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.aff-chat button{border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:5px 12px;color:inherit}
.aff-chat button:disabled{opacity:.48}.aff-chat [role=alert]{color:var(--error-text,inherit);font-weight:550}
`
async function api(id, options = {}) {
  const response = await fetch(endpoint + (id ? '?preset=' + encodeURIComponent(id) : ''), { cache: 'no-store', ...options })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败。')
  return data
}

function ChatSettings() {
  const [rows, setRows] = useState([])
  const [id, select] = useState('')
  const [detail, setDetail] = useState(null)
  const [drafts, setDrafts] = useState(new Map())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
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
      const settings = await api(id, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
      })
      setDetail(previous => previous?.id === id ? { ...previous, settings } : previous)
      setDrafts(previous => { const next = new Map(previous); next.delete(id); return next })
      setNotice('已保存。')
    } catch (err) { setNotice(err.message) }
    finally { setSaving(false); refreshRef.current() }
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
    value && data && h('label', { className: 'field' }, '人格提示词',
      h('textarea', { value: value.persona, disabled: saving, onChange: e => edit({ persona: e.target.value }) })),
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
    data && h('section', { className: 'field' }, h('h3', null, '当前情感数值'),
      data.values ? h('dl', null, Object.entries(labels).map(([key, label]) =>
        h('div', { key }, h('dt', null, label), h('dd', null, data.values[key].toFixed(1)))))
        : h('p', { className: 'hint' }, '暂无情绪档案')))
}
exports.inject = ['slots']
exports.apply = ctx => {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'affection', order: 81, label: () => '情感聊天',
  }, ChatSettings))
}
