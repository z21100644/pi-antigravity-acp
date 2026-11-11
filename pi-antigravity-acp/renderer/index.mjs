import React from 'react'
import { createPortal } from 'react-dom'
import { percent, wholePercent, resetTime, selectedGroup, shortGroup } from './format.mjs'

const h = React.createElement
let host
const dictionary = {
  en: { quota: 'Subscription quota', remaining: 'remaining', weekly: 'Weekly', reset: 'Resets', empty: 'Waiting for official quota', stale: 'Last known quota', updated: 'Updated', active: 'Current' },
  tw: { quota: '訂閱剩餘額度', remaining: '剩餘', weekly: '每週', reset: '重置', empty: '等待官方額度', stale: '上次已知額度', updated: '更新時間', active: '目前使用' },
  cn: { quota: '订阅剩余额度', remaining: '剩余', weekly: '每周', reset: '重置', empty: '等待官方额度', stale: '上次已知额度', updated: '更新时间', active: '当前使用' },
}
function language() {
  const locale = document.documentElement.lang || navigator.language || 'en'
  return { locale, t: !/^zh/i.test(locale) ? dictionary.en : /TW|HK|Hant/i.test(locale) ? dictionary.tw : dictionary.cn }
}
function meter(value) {
  const known = Number.isFinite(value)
  return h('span', { className: 'agy-meter-track', 'aria-hidden': true },
    h('span', { className: 'agy-meter-fill', style: { width: `${known ? value * 100 : 0}%`,
      background: known && value < 0.1 ? '#e47c7c' : known && value < 0.25 ? '#e5b76a' : undefined } }))
}

function Monitor() {
  const { locale, t } = language()
  const id = React.useId()
  const trigger = React.useRef(null), panel = React.useRef(null)
  const focusPopup = React.useRef(false)
  const [snapshot, setSnapshot] = React.useState(null), [error, setError] = React.useState(null)
  const [open, setOpen] = React.useState(false), [layer, setLayer] = React.useState(null)
  const [position, setPosition] = React.useState(null)
  const inflight = React.useRef(false), live = React.useRef(true)
  const load = React.useCallback(async () => {
    if (inflight.current || !host) return
    inflight.current = true
    try {
      const next = await host.dispatch('plugin.call', { method: 'monitor.snapshot' })
      if (live.current) { setSnapshot(next); setError(null) }
    } catch (failure) {
      if (live.current) setError(String(failure?.message ?? failure))
    } finally { inflight.current = false }
  }, [])
  const close = React.useCallback(returnFocus => {
    setOpen(false)
    if (returnFocus) trigger.current?.focus({ preventScroll: true })
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
      if (!document.hidden) await load()
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
    const escape = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
    }
    document.addEventListener('keydown', escape)
    return () => { next.close(); setLayer(null); setPosition(null); document.removeEventListener('keydown', escape) }
  }, [open, close])
  React.useLayoutEffect(() => {
    if (!open || !layer || !trigger.current || !panel.current) return
    let frame, focusFrame
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), popup = panel.current
      if (!anchor || !popup) return
      const width = Math.min(240, window.innerWidth - 24)
      const left = Math.max(12, Math.min(anchor.left - 8, window.innerWidth - width - 12))
      const height = popup.offsetHeight
      const top = anchor.top - height - 10 >= 12 ? anchor.top - height - 10
        : Math.max(12, Math.min(anchor.bottom + 10, window.innerHeight - height - 12))
      setPosition(previous => previous?.left === left && previous.top === top ? previous : { left, top })
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place) }
    const observer = new ResizeObserver(schedule)
    observer.observe(trigger.current)
    observer.observe(panel.current)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    place()
    if (focusPopup.current) {
      focusFrame = requestAnimationFrame(() => {
        focusPopup.current = false
        panel.current?.querySelector('button')?.focus({ preventScroll: true })
      })
    }
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(focusFrame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [open, layer])
  const quota = snapshot?.quota, groups = quota?.groups ?? []
  const group = selectedGroup(groups, snapshot?.session?.current?.model)
  const bucket = group?.buckets.find(item => item.window === '5h')
  const failure = error ?? quota?.error ?? snapshot?.selectionError
  const detail = [quota?.stale ? t.stale : null,
    quota?.updatedAt ? `${t.updated} ${resetTime(quota.updatedAt, locale)}` : null, failure].filter(Boolean).join(' · ')
  const popup = open && layer ? createPortal(
    h('div', { className: 'agy-monitor-backdrop', onPointerDown: () => close(false) },
      h('section', { className: 'agy-monitor', id, ref: panel, role: 'dialog', 'aria-modal': false, 'aria-label': t.quota,
        style: { left: position?.left ?? 12, top: position?.top ?? 12, visibility: position ? undefined : 'hidden' },
        onPointerDown: event => event.stopPropagation() },
      groups.length ? groups.map((item, groupIndex) => h('article', { className: 'agy-quota-group', key: item.name },
        h('div', { className: 'agy-group-title' }, h('strong', null, shortGroup(item)),
          item === group && !snapshot?.selectionError ? h('span', { className: 'agy-active-label' }, t.active) : null),
        ...[...item.buckets].sort((a, b) => (a.window === '5h' ? -1 : 1) - (b.window === '5h' ? -1 : 1)).map((value, bucketIndex) => {
          const label = value.window === '5h' ? '5H' : value.window === 'weekly' ? t.weekly : value.name
          const tooltip = `${id}-reset-${groupIndex}-${bucketIndex}`
          return h('button', { type: 'button', className: 'agy-bucket', key: value.id, 'aria-describedby': tooltip,
            'aria-label': `${shortGroup(item)} ${label}, ${percent(value.remainingFraction)} ${t.remaining}` },
            h('span', { className: 'agy-row' }, h('span', null, label), h('span', { className: 'agy-quota-value' }, percent(value.remainingFraction))),
            meter(value.remainingFraction),
            h('span', { className: 'agy-reset-tooltip', role: 'tooltip', id: tooltip }, `${t.reset} ${resetTime(value.resetTime, locale)}`))
        }))) : h('p', { className: 'agy-empty', role: 'status' }, t.empty),
      quota?.stale || failure ? h('p', { className: 'agy-error', role: 'status' }, [quota?.stale ? t.stale : null, failure].filter(Boolean).join(' · ')) : null)),
    layer.element) : null
  return h(React.Fragment, null, h('button', { type: 'button', ref: trigger, className: 'agy-quota-button', title: detail || t.quota,
    'aria-label': `${t.quota}, ${shortGroup(group)} 5H ${wholePercent(bucket?.remainingFraction)} ${t.remaining}`,
    'aria-haspopup': 'dialog', 'aria-controls': open ? id : undefined, 'aria-expanded': open,
    onClick: event => { focusPopup.current = !open && event.detail === 0; setOpen(value => !value) } },
    meter(bucket?.remainingFraction), h('span', null, '5H'), h('span', null, wholePercent(bucket?.remainingFraction))), popup)
}

const CSS = `
.agy-quota-button,.agy-monitor-backdrop{--agy-text:var(--ds-text-primary,#eeeef0);--agy-secondary:var(--ds-text-secondary,#a2a2a2);--agy-border:color-mix(in srgb,var(--agy-text) 13%,transparent);--agy-track:color-mix(in srgb,var(--agy-text) 15%,transparent);--agy-meter:light-dark(#5ca98c,#78bfa3);--agy-hover:color-mix(in srgb,var(--agy-text) 8%,transparent);color:var(--agy-text);font-family:inherit}
.agy-quota-button{display:inline-flex;align-items:center;gap:4px;min-height:28px;box-sizing:border-box;margin:0;padding:3px 4px;border:0;border-radius:6px;background:transparent;font:inherit;font-size:var(--text-xs,14px);font-weight:var(--font-weight-semibold,500);line-height:var(--leading-compact,20px);font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}
.agy-quota-button:hover,.agy-quota-button[aria-expanded=true]{background:var(--agy-hover)}
.agy-quota-button>span{font:inherit;color:inherit;line-height:inherit;letter-spacing:normal}
.agy-meter-track{display:block;flex-shrink:0;width:100%;height:4px;border-radius:2px;background:var(--agy-track);overflow:hidden}
.agy-meter-fill{display:block;height:100%;border-radius:inherit;background:var(--agy-meter)}
.agy-quota-button>.agy-meter-track{width:22px}
.agy-monitor-backdrop{position:fixed;inset:0}
.agy-monitor{position:fixed;width:240px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow-y:auto;box-sizing:border-box;padding:12px;border:1px solid var(--agy-border);border-radius:10px;background:var(--ds-bg-secondary,#292929);color:var(--agy-text);box-shadow:0 6px 20px #0003;font:12px/1.4 var(--font-sans,system-ui,sans-serif)}
.agy-monitor *{box-sizing:border-box}
.agy-quota-group+.agy-quota-group{margin-top:10px;padding-top:10px;border-top:1px solid var(--agy-border)}
.agy-group-title{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;font-size:12px}
.agy-group-title strong{font:inherit;font-weight:500}
.agy-active-label{color:var(--agy-secondary);font-size:11px}
.agy-bucket{position:relative;display:block;width:calc(100% + 6px);margin:0 -3px;padding:4px 3px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:default}
.agy-bucket:hover{background:var(--agy-hover)}
.agy-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px;color:var(--agy-secondary)}
.agy-quota-value{color:var(--agy-text);font-weight:500;font-variant-numeric:tabular-nums}
.agy-reset-tooltip{display:none;position:absolute;left:3px;bottom:calc(100% + 4px);z-index:1;width:max-content;max-width:calc(100% - 6px);padding:5px 8px;border:1px solid var(--agy-border);border-radius:7px;background:var(--ds-bg-primary,#202020);color:var(--agy-text);box-shadow:0 3px 10px #0003;font:11px/1.4 var(--font-sans,system-ui,sans-serif);overflow-wrap:anywhere;pointer-events:none}
.agy-bucket:hover>.agy-reset-tooltip,.agy-bucket:focus-visible>.agy-reset-tooltip{display:block}
.agy-empty{margin:0;color:var(--agy-secondary)}
.agy-error{margin:10px 0 0;color:var(--ds-text-danger,#e69b88);font-size:11px;overflow-wrap:anywhere}
`
export function onLoad(pi) {
  host = pi
  pi.ui.injectStyle(CSS)
  pi.slots.register({ slot: 'composerControl', component: Monitor, positions: ['right'] })
}
export function onUnload() { host = null }
