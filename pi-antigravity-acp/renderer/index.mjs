import React from 'react'
import { createPortal } from 'react-dom'
import { number, percent, resetTime, selectedGroup, shortGroup } from './format.mjs'

const h = React.createElement
let host
const dictionary = {
  en: { title: 'Usage Monitor', quota: 'Subscription quota', remaining: 'remaining', weekly: 'Weekly', hours: '5 hours', reset: 'Resets', refresh: 'Refresh', refreshing: 'Refreshing…', empty: 'Waiting for official quota', stale: 'Last known snapshot', updated: 'Updated', usage: 'Current conversation', totals: 'Reported since this monitor started', idle: 'No AGY request in this conversation yet', generating: 'Generating', waiting_tools: 'Waiting for tools', completed: 'Completed', aborted: 'Cancelled', error: 'Request failed', estimate: 'Estimated output', exact: 'SQLite settled', reported: 'ACP reported', input: 'Input', output: 'Output', cache: 'Cache read/write', close: 'Close monitor', unknown: 'Unavailable', retry: 'Retry available in', seconds: 's', selection: 'Conversation selection unavailable' },
  tw: { title: 'Usage Monitor', quota: '訂閱剩餘額度', remaining: '剩餘', weekly: '每週', hours: '五小時', reset: '重置', refresh: '更新', refreshing: '更新中…', empty: '等待官方額度', stale: '上次已知快照', updated: '更新時間', usage: '目前對話', totals: '監控啟用後已回報累計', idle: '此對話尚無 AGY 請求', generating: '生成中', waiting_tools: '等待工具', completed: '已完成', aborted: '已取消', error: '請求失敗', estimate: '輸出估算', exact: 'SQLite 已結算', reported: 'ACP 回報', input: '輸入', output: '輸出', cache: '快取讀／寫', close: '關閉額度面板', unknown: '尚無資料', retry: '可再次更新倒數', seconds: '秒', selection: '無法取得目前對話' },
  cn: { title: 'Usage Monitor', quota: '订阅剩余额度', remaining: '剩余', weekly: '每周', hours: '五小时', reset: '重置', refresh: '更新', refreshing: '更新中…', empty: '等待官方额度', stale: '上次已知快照', updated: '更新时间', usage: '当前对话', totals: '监控启用后已报告累计', idle: '此对话尚无 AGY 请求', generating: '生成中', waiting_tools: '等待工具', completed: '已完成', aborted: '已取消', error: '请求失败', estimate: '输出估算', exact: 'SQLite 已结算', reported: 'ACP 报告', input: '输入', output: '输出', cache: '缓存读／写', close: '关闭额度面板', unknown: '暂无数据', retry: '可再次更新倒计时', seconds: '秒', selection: '无法获取当前对话' },
}
function language() {
  const locale = document.documentElement.lang || navigator.language || 'en'
  return { locale, t: !/^zh/i.test(locale) ? dictionary.en : /TW|HK|Hant/i.test(locale) ? dictionary.tw : dictionary.cn }
}

function Monitor() {
  const { locale, t } = language()
  const [snapshot, setSnapshot] = React.useState(null), [error, setError] = React.useState(null)
  const [open, setOpen] = React.useState(false), [layer, setLayer] = React.useState(null)
  const inflight = React.useRef(false), live = React.useRef(true)
  const load = React.useCallback(async force => {
    if (inflight.current || !host) return
    inflight.current = true
    try {
      const next = await host.dispatch('plugin.call', { method: force ? 'monitor.refresh' : 'monitor.snapshot' })
      if (live.current) { setSnapshot(next); setError(null) }
    } catch (failure) {
      if (live.current) setError(String(failure?.message ?? failure))
    } finally { inflight.current = false }
  }, [])
  React.useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  React.useEffect(() => {
    let stopped = false, timer, polling = false
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      if (!document.hidden) await load(false)
      polling = false
      if (!stopped) timer = setTimeout(poll, open ? 1000 : 5000)
    }
    const visible = () => { clearTimeout(timer); void poll() }
    void poll()
    document.addEventListener('visibilitychange', visible)
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [open, load])
  React.useEffect(() => {
    if (!open || !host) return
    const next = host.ui.openLayer()
    setLayer(next)
    const escape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', escape)
    return () => { next.close(); setLayer(null); document.removeEventListener('keydown', escape) }
  }, [open])
  const quota = snapshot?.quota, groups = quota?.groups ?? [], session = snapshot?.session
  const current = session?.current, group = selectedGroup(groups, current?.model)
  const bucket = group?.buckets.find(item => item.window === '5h')
  const weekly = group?.buckets.find(item => item.window === 'weekly')
  const cooldown = Math.max(0, Math.ceil(((quota?.refreshAllowedAt ?? 0) - (snapshot?.serverTime ?? 0)) / 1000))
  const badge = group ? `${shortGroup(group)} 5h ${percent(bucket?.remainingFraction)} · ${t.weekly} ${percent(weekly?.remainingFraction)}` : `AGY · ${t.empty}`
  const panel = open && layer ? createPortal(h('div', { className: 'agy-monitor-backdrop', onClick: () => setOpen(false) },
    h('section', { className: 'agy-monitor', role: 'dialog', 'aria-label': t.title, onClick: event => event.stopPropagation() },
      h('header', null, h('div', null, h('strong', null, t.title), h('small', null, t.quota)),
        h('button', { type: 'button', className: 'agy-close', onClick: () => setOpen(false), 'aria-label': t.close }, '×')),
      groups.length ? groups.map(item => h('article', { className: 'agy-quota-group', key: item.name },
        h('strong', null, shortGroup(item)),
        ...[...item.buckets].sort((a, b) => (a.window === '5h' ? -1 : 1) - (b.window === '5h' ? -1 : 1)).map(value =>
          h('div', { className: 'agy-bucket', key: value.id },
            h('div', { className: 'agy-row' }, h('span', null, value.window === '5h' ? t.hours : value.window === 'weekly' ? t.weekly : value.name), h('b', null, `${percent(value.remainingFraction)} ${t.remaining}`)),
            h('progress', { max: 1, value: value.remainingFraction, 'aria-label': `${shortGroup(item)} ${value.window}`, style: { '--bar-color': value.remainingFraction < 0.1 ? '#e47c7c' : value.remainingFraction < 0.25 ? '#e5b76a' : '#73c7ac' } }),
            h('small', null, `${t.reset} ${resetTime(value.resetTime, locale)}`))))) : h('p', { className: 'agy-muted' }, t.empty),
      h('div', { className: 'agy-refresh-row' }, h('small', null,
        quota?.updatedAt ? `${quota.stale ? `${t.stale} · ` : ''}${t.updated} ${resetTime(quota.updatedAt, locale)}` : t.unknown),
        h('button', { type: 'button', onClick: () => void load(true), disabled: quota?.refreshing || cooldown > 0,
          title: cooldown ? `${t.retry} ${cooldown} ${t.seconds}` : t.refresh }, quota?.refreshing ? t.refreshing : t.refresh)),
      error || quota?.error ? h('p', { className: 'agy-error', role: 'status' }, error ?? quota.error) : null,
      h('div', { className: 'agy-usage' }, h('div', { className: 'agy-row' }, h('strong', null, t.usage),
        current ? h('span', { className: 'agy-status' }, t[current.status] ?? current.status) : null),
        snapshot?.selectionError ? h('p', { className: 'agy-error' }, t.selection) : null,
        current ? h(React.Fragment, null,
          h('small', null, current.model),
          ['generating', 'waiting_tools'].includes(current.status) && current.outputCharacters > 0 ? h('p', { className: 'agy-estimate' }, `${t.estimate} ≈ ${number(current.estimatedOutputTokens, locale)} tokens`) : null,
          current.usage ? h('div', { className: 'agy-token-grid' },
            h('div', null, h('small', null, t.input), h('b', null, number(current.usage.inputTokens, locale))),
            h('div', null, h('small', null, t.output), h('b', null, number(current.usage.outputTokens, locale))),
            h('div', null, h('small', null, t.cache), h('b', null, `${number(current.usage.cacheReadTokens, locale)} / ${number(current.usage.cacheWriteTokens, locale)}`))) : null,
          h('div', { className: 'agy-row agy-total' }, h('small', null, t.totals), h('b', null, `${number(session.totals.totalTokens, locale)} tokens`)),
          current.usage ? h('small', null, current.exact ? t.exact : t.reported) : null) : h('p', { className: 'agy-muted' }, t.idle)))) , layer.element) : null
  return h(React.Fragment, null, h('button', { type: 'button', className: 'agy-quota-button', title: t.title, 'aria-label': t.title, 'aria-haspopup': 'dialog',
    'aria-expanded': open, onClick: () => setOpen(!open) }, h('span', { className: `agy-dot${error || quota?.stale ? ' agy-dot-error' : ''}` }), badge), panel)
}

const CSS = `
.agy-quota-button{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11px;white-space:nowrap;max-width:235px;overflow:hidden;text-overflow:ellipsis;padding:4px 6px;cursor:pointer;opacity:.85}
.agy-quota-button:hover{background:#8882;opacity:1}.agy-dot{width:6px;height:6px;border-radius:50%;background:#73c7ac;flex-shrink:0}.agy-dot-error{background:#e5b76a}
.agy-monitor-backdrop{position:fixed;inset:0}.agy-monitor{position:fixed;right:24px;bottom:104px;width:360px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 150px);overflow:auto;box-sizing:border-box;border:1px solid #8884;border-radius:14px;background:var(--ds-bg-secondary,#242426);color:var(--ds-text-primary,#eeeef0);box-shadow:0 14px 54px #0005;padding:18px;font:12px/1.5 system-ui,sans-serif}
.agy-monitor header{display:flex;justify-content:space-between;align-items:start;margin-bottom:16px}.agy-monitor header strong{font-size:15px}.agy-monitor small{display:block;opacity:.62;font-size:10px}.agy-close{font-size:22px!important;border:0!important;background:transparent!important;padding:0 4px!important;line-height:1}
.agy-monitor button{font:inherit;color:inherit;background:#8882;border:1px solid #8883;border-radius:6px;padding:4px 9px;cursor:pointer}.agy-monitor button:disabled{opacity:.45;cursor:default}.agy-quota-group+.agy-quota-group{margin-top:18px}.agy-quota-group>strong{font-size:12px}.agy-bucket{margin-top:8px}.agy-row{display:flex;justify-content:space-between;align-items:center;gap:10px}.agy-bucket progress{display:block;width:100%;height:7px;margin:5px 0 3px;border:0;border-radius:8px;overflow:hidden;background:#8883}.agy-bucket progress::-webkit-progress-bar{background:#8883;border-radius:8px}.agy-bucket progress::-webkit-progress-value{background:var(--bar-color,#73c7ac);border-radius:8px}
.agy-refresh-row{display:flex;justify-content:space-between;align-items:center;margin-top:16px;gap:12px}.agy-error{color:#e69b88;overflow-wrap:anywhere;font-size:11px}.agy-usage{margin-top:16px;border-top:1px solid #8883;padding-top:14px}.agy-status{font-size:10px;opacity:.7}.agy-muted{opacity:.6}.agy-estimate{color:#9dc9e7;margin:8px 0}.agy-token-grid{display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:8px;margin-top:10px}.agy-token-grid b{font-size:12px}.agy-total{margin-top:12px}.agy-total b{font-size:12px}
@media(max-width:650px){.agy-quota-button{max-width:145px;font-size:10px}.agy-monitor{right:12px;bottom:100px}}
`
export function onLoad(pi) {
  host = pi
  pi.ui.injectStyle(CSS)
  pi.slots.register({ slot: 'composerControl', component: Monitor, positions: ['left'] })
}
export function onUnload() { host = null }
