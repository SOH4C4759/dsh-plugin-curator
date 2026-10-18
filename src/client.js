// dsh-plugin-curator — browser half.
//
// Two registrations, both INSIDE the shipped Plugins page — the curator is a
// view of that page, not a second sidebar entry of its own:
//
//   ctx.slots.inject('plugins.tab', () => ctx.slots.register(
//     { name: 'plugins.tab', id: TAB_ID, order: 10, label: () => '插件管家' }, CuratorPage))
//   ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(
//     { name: 'plugins.detail.section', id: DETAIL_ID, order: 10, label: () => '插件管家' }, CuratorDetail))
//
// `plugins.tab` is the shipped seam for "a tab after the page's own Installed
// tab": the entry's `id` IS the tab key (the page renders the slot with
// `{ only: tab }`), and the component draws the tab body under the page's own
// header and tab strip. `plugins.detail.section` adds the same facts to one
// plugin's own page, where the subject is already chosen.
//
// The panel draws four things and never invents a fifth:
//
//   概览    one line per question the plugin exists to answer, with the number
//           and the measurement basis next to it.
//   插件    every live Loader entry: state, cold-load cost, UI bundle, calls.
//   建议    the verdicts the Host computed (`reasons[].code`), each with the
//           action that follows from it.
//   启动    the three separately-measured startup numbers, the per-plugin bars,
//           and the boot history with A/B deltas across composition changes.
//   清理    failed / version-incompatible / stalled entries, entries already
//           disabled, and the quarantine bin that 找回 reads from.
//
// All numbers arrive from the Host; this half measures exactly one thing of its
// own — the browser's Resource Timing for each plugin's client bundle — and posts
// it back so the panel can show a real UI-side cost instead of a guess.

;(function () {
  'use strict'

  window.__ModuleLoader__.load({
    id: 'dsh-plugin-curator',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      /** Tab key inside the Plugins page (`plugins.tab` occupant id). */
      const TAB_ID = 'curator'
      /** Section id on one plugin's own detail page. */
      const DETAIL_ID = 'curator-detail'
      const STYLE_ID = 'dsh-plugin-curator-styles'
      const BASE = '/api/plugin-curator'
      const REQUEST_TIMEOUT_MS = 25_000
      const POLL_MS = 5_000
      const JOB_POLL_MS = 1_500

      const CSS = `
.dspc-root { display: flex; flex-direction: column; height: 100%; min-height: 460px;
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #111);
  font-size: 13px; line-height: 1.55; }
.dspc-bar { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  background: var(--dsw-alias-bg-layer-1, #fafafa); }
.dspc-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dspc-title { font-weight: 650; font-size: 14px; white-space: nowrap; }
.dspc-sub { color: var(--dsw-alias-label-secondary, #666); font-size: 12px; white-space: nowrap; }
.dspc-grow { flex: 1 1 auto; }
.dspc-chip { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;
  border-radius: 11px; font-size: 12px; white-space: nowrap;
  background: var(--dsw-alias-bg-layer-2, #f1f2f4); color: var(--dsw-alias-label-secondary, #555); }
.dspc-chip[data-tone="good"] { background: color-mix(in srgb, #16a34a 14%, transparent); color: #12703f; }
.dspc-chip[data-tone="warn"] { background: color-mix(in srgb, #d97706 16%, transparent); color: #92510a; }
.dspc-chip[data-tone="bad"] { background: color-mix(in srgb, #dc2626 14%, transparent); color: #a41919; }
.dspc-btn { height: 26px; padding: 0 10px; border-radius: 6px; font: inherit; font-size: 12px;
  cursor: pointer; border: 1px solid var(--dsw-alias-border-l1, #d4d4d8); background: transparent;
  color: var(--dsw-alias-label-primary, #111); white-space: nowrap; }
.dspc-btn:hover:not([disabled]) { background: var(--dsw-alias-bg-layer-2, #f4f4f5); }
.dspc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2563eb); outline-offset: 1px; }
.dspc-btn[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-brand-primary, #2563eb); color: #fff; }
.dspc-btn[data-danger="true"] { border-color: color-mix(in srgb, #dc2626 40%, transparent); color: #b91c1c; }
.dspc-btn[disabled] { opacity: .55; cursor: default; }
.dspc-btn[data-small="true"] { height: 22px; padding: 0 8px; font-size: 11.5px; }
.dspc-tabs { display: flex; gap: 2px; flex: 0 0 auto; padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb); overflow-x: auto; }
.dspc-tab { position: relative; height: 34px; padding: 0 12px; border: 0; background: transparent;
  color: var(--dsw-alias-label-secondary, #666); font: inherit; font-size: 12.5px; cursor: pointer;
  white-space: nowrap; }
.dspc-tab[data-active="true"] { color: var(--dsw-alias-label-primary, #111); font-weight: 600; }
.dspc-tab[data-active="true"]::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px;
  height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary, #2563eb); }
.dspc-tab .dspc-count { margin-left: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
.dspc-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 14px 28px; }
.dspc-notice { margin: 0 14px; margin-top: 10px; padding: 7px 10px; border-radius: 7px; font-size: 12px;
  background: var(--dsw-alias-bg-layer-2, #f4f4f5); color: var(--dsw-alias-label-secondary, #555); }
.dspc-notice[data-kind="error"] { color: #b42318; background: color-mix(in srgb, #dc2626 10%, transparent); }
.dspc-notice[data-kind="ok"] { color: #0f6b3f; background: color-mix(in srgb, #16a34a 10%, transparent); }
.dspc-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
.dspc-card { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1, #fbfcfd); }
.dspc-card-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dspc-card-value { font-size: 20px; font-weight: 650; letter-spacing: -.2px; margin-top: 2px; }
.dspc-card-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); margin-top: 2px; }
.dspc-section { margin-top: 18px; }
.dspc-section-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.dspc-section-title { font-weight: 650; font-size: 13px; }
.dspc-section-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dspc-rows { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; overflow: hidden; }
.dspc-row { display: grid; align-items: center; gap: 10px; padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #eceef1); }
.dspc-row:last-child { border-bottom: 0; }
.dspc-row[data-head="true"] { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280);
  background: var(--dsw-alias-bg-layer-1, #fafbfc); padding: 6px 12px; }
.dspc-row:not([data-head="true"]):hover { background: var(--dsw-alias-bg-layer-1, #fafbfc); }
.dspc-cols-plugins { grid-template-columns: minmax(170px, 2.3fr) 62px 68px 76px 74px 66px 92px 96px; }
.dspc-cols-startup { grid-template-columns: minmax(170px, 2fr) 84px 1fr; }
.dspc-cols-history { grid-template-columns: 132px 92px 68px 110px 1fr; }
.dspc-name { display: flex; flex-direction: column; min-width: 0; }
.dspc-name-main { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dspc-name-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dspc-num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.dspc-muted { color: var(--dsw-alias-label-secondary, #6b7280); }
.dspc-badge { display: inline-block; padding: 0 6px; height: 19px; line-height: 19px; border-radius: 5px;
  font-size: 11px; white-space: nowrap; background: var(--dsw-alias-bg-layer-2, #f1f2f4);
  color: var(--dsw-alias-label-secondary, #555); }
.dspc-badge[data-tone="keep"] { background: color-mix(in srgb, #16a34a 13%, transparent); color: #12703f; }
.dspc-badge[data-tone="review"] { background: color-mix(in srgb, #d97706 15%, transparent); color: #92510a; }
.dspc-badge[data-tone="disable"] { background: color-mix(in srgb, #b45309 20%, transparent); color: #7c3a06; }
.dspc-badge[data-tone="cleanup"] { background: color-mix(in srgb, #dc2626 14%, transparent); color: #a41919; }
.dspc-badge[data-tone="idle"] { background: var(--dsw-alias-bg-layer-2, #eef0f2); color: #555; }
.dspc-bar-track { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, #eef0f2); overflow: hidden; }
.dspc-bar-fill { height: 100%; border-radius: 3px; background: var(--dsw-alias-brand-primary, #2563eb); }
.dspc-item { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; padding: 10px 12px;
  margin-bottom: 8px; background: var(--dsw-alias-bg-layer-1, #fbfcfd); }
.dspc-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dspc-item-title { font-weight: 600; }
.dspc-reasons { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.dspc-reasons li { font-size: 12px; color: var(--dsw-alias-label-secondary, #555); }
.dspc-reasons code { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.dspc-actions { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.dspc-empty { padding: 26px 12px; text-align: center; color: var(--dsw-alias-label-secondary, #6b7280); }
.dspc-filter { height: 26px; min-width: 180px; padding: 0 8px; border-radius: 6px; font: inherit; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #d4d4d8); background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #111); }
.dspc-note { font-size: 12px; color: var(--dsw-alias-label-secondary, #555); line-height: 1.75; }
.dspc-note code { font-size: 11.5px; padding: 1px 4px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #f1f2f4); }
.dspc-confirm { font-size: 12px; color: #b42318; display: flex; align-items: center; gap: 6px; }
.dspc-detail { margin-top: 14px; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: var(--dsw-alias-bg-layer-1, #fbfcfd); }
.dspc-detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.dspc-detail-title { font-weight: 650; font-size: 12.5px; }
.dspc-detail-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); }
.dspc-detail-cell { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dspc-detail-cell b { display: block; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #111); }
.dspc-detail-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); margin-top: 8px; line-height: 1.7; }
.dspc-detail-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
`

      function ensureStyles() {
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.setAttribute('data-plugin', 'dsh-plugin-curator')
        style.setAttribute('data-plugin-css', STYLE_ID)
        style.textContent = CSS
        document.head.append(style)
      }

      /* --------------------------------------------------------- helpers -- */

      async function postJson(path, body) {
        const controller = new AbortController()
        const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const response = await fetch(BASE + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
            signal: controller.signal,
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          return { ok: true, status: response.status, payload }
        } catch (error) {
          return { ok: false, aborted: controller.signal.aborted, error: String(error?.message ?? error) }
        } finally {
          globalThis.clearTimeout(timer)
        }
      }

      const ms = (value) => (Number.isFinite(value) ? `${String(Math.round(value))} ms` : '—')
      const kb = (value) => {
        if (!Number.isFinite(value)) return '—'
        if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
        return `${String(Math.round(value / 1024))} KB`
      }
      const clock = (at) => {
        if (!Number.isFinite(at)) return '—'
        const when = new Date(at)
        const pad = (n) => String(n).padStart(2, '0')
        return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
      }
      const signed = (value) => {
        if (!Number.isFinite(value)) return '—'
        const rounded = Math.round(value)
        return `${rounded > 0 ? '+' : ''}${String(rounded)} ms`
      }

      const VERDICT = {
        keep: { text: '保留', tone: 'keep' },
        idle: { text: '已停用', tone: 'idle' },
        review: { text: '待确认', tone: 'review' },
        disable: { text: '可停用', tone: 'disable' },
        cleanup: { text: '可清理', tone: 'cleanup' },
      }

      const KIND = {
        inbox: '内置',
        link: '本地链接',
        file: '本地包',
        workspace: '工作区',
        git: 'Git',
        registry: '市场',
      }

      const PHASE = {
        active: '运行中',
        failed: '加载失败',
        loading: '加载中',
        pending: '待加载',
        unloading: '卸载中',
      }

      function Chip(props) {
        return h('span', { className: 'dspc-chip', 'data-tone': props.tone }, props.children)
      }

      function Badge(props) {
        return h('span', { className: 'dspc-badge', 'data-tone': props.tone }, props.children)
      }

      function Metric(props) {
        return h('div', { className: 'dspc-card' },
          h('div', { className: 'dspc-card-label' }, props.label),
          h('div', { className: 'dspc-card-value' }, props.value),
          props.note === undefined ? null : h('div', { className: 'dspc-card-note' }, props.note))
      }

      /** Boot history as bars; the newest record is the rightmost one. */
      function Spark(props) {
        const values = props.values.filter((value) => Number.isFinite(value))
        if (values.length === 0) return h('div', { className: 'dspc-empty' }, '还没有启动记录')
        const max = Math.max(...values)
        const width = Math.max(120, values.length * 14)
        return h('svg', { width: '100%', height: 64, viewBox: `0 0 ${String(width)} 64`, preserveAspectRatio: 'none' },
          values.map((value, index) => {
            const ratio = max === 0 ? 0 : value / max
            const barHeight = Math.max(2, Math.round(ratio * 56))
            return h('rect', {
              key: String(index),
              x: index * 14 + 1,
              y: 60 - barHeight,
              width: 10,
              height: barHeight,
              rx: 2,
              fill: index === values.length - 1 ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-border-l1, #cbd5e1)',
            })
          }))
      }

      /* ------------------------------------------------------------ page -- */

      function CuratorPage() {
        const [report, setReport] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [tab, setTab] = React.useState('overview')
        const [busy, setBusy] = React.useState('')
        const [notice, setNotice] = React.useState(null)
        const [filter, setFilter] = React.useState('')
        const [confirming, setConfirming] = React.useState('')

        const load = React.useCallback(async (silent) => {
          const result = await postJson('/report', {})
          if (!result.ok) {
            if (silent !== true) setError(result.aborted ? '请求超时：Host 可能已退出' : `无法连接 Host：${result.error}`)
            return
          }
          if (result.payload?.ok === true) {
            setReport(result.payload.value)
            setError(null)
            return
          }
          if (silent !== true) setError(result.payload?.error ?? `HTTP ${String(result.status)}`)
        }, [])

        React.useEffect(() => {
          void load(false)
          const timer = globalThis.setInterval(() => {
            void load(true)
          }, POLL_MS)
          return () => globalThis.clearInterval(timer)
        }, [load])

        /** Report the browser's own bundle cost once per page load. */
        React.useEffect(() => {
          const boot = globalThis.__DSH_BOOT__
          const entries = boot !== null && typeof boot === 'object' && Array.isArray(boot.entries) ? boot.entries : []
          if (entries.length === 0) return
          let resources = []
          try {
            resources = globalThis.performance.getEntriesByType('resource')
          } catch {
            resources = []
          }
          const byId = {}
          for (const entry of entries) {
            if (typeof entry?.url !== 'string' || typeof entry?.id !== 'string') continue
            const match = resources.find((resource) => {
              const name = String(resource?.name ?? '')
              return name.indexOf(entry.url) >= 0 || name.split('?')[0] === entry.url
            })
            if (match === undefined) continue
            byId[entry.id] = {
              durationMs: match.duration,
              transferSize: match.transferSize,
              encodedBodySize: match.encodedBodySize,
              startMs: match.startTime,
            }
          }
          if (Object.keys(byId).length === 0) return
          void postJson('/client-timing', {
            navigationMs: Math.round(globalThis.performance.now()),
            entries: byId,
          })
        }, [])

        // While a Host job runs, poll faster so progress is visible.
        const jobRunning = report?.jobs?.bench?.state === 'running' || report?.jobs?.activity?.state === 'running'
        React.useEffect(() => {
          if (jobRunning !== true) return undefined
          const timer = globalThis.setInterval(() => {
            void load(true)
          }, JOB_POLL_MS)
          return () => globalThis.clearInterval(timer)
        }, [jobRunning, load])

        const act = React.useCallback(async (key, path, body, describe) => {
          setBusy(key)
          setNotice(null)
          const result = await postJson(path, body)
          setBusy('')
          if (!result.ok || result.payload?.ok !== true) {
            setError(result.payload?.error ?? `操作失败：HTTP ${String(result.status)}`)
            return null
          }
          setConfirming('')
          if (typeof describe === 'function') {
            const text = describe(result.payload.value)
            if (typeof text === 'string' && text !== '') setNotice({ kind: 'ok', text })
          }
          await load(true)
          return result.payload.value
        }, [load])

        if (error !== null && report === null) {
          return h('div', { className: 'dspc-root' },
            h('div', { className: 'dspc-bar' },
              h('div', { className: 'dspc-heading' },
                h('span', { className: 'dspc-title' }, '插件管家'),
                h('span', { className: 'dspc-sub' }, '本地插件审计'))),
            h('div', { className: 'dspc-notice', 'data-kind': 'error' }, error))
        }

        if (report === null) {
          return h('div', { className: 'dspc-root' },
            h('div', { className: 'dspc-bar' },
              h('div', { className: 'dspc-heading' },
                h('span', { className: 'dspc-title' }, '插件管家'),
                h('span', { className: 'dspc-sub' }, '正在读取插件清单…'))))
        }

        const totals = report.totals ?? {}
        const plugins = Array.isArray(report.plugins) ? report.plugins : []
        const suggestions = Array.isArray(report.suggestions) ? report.suggestions : []
        const cleanup = report.cleanup ?? { broken: [], disabled: [], trash: [], history: [] }
        const boot = report.boot ?? { current: {}, history: [] }
        const jobs = report.jobs ?? {}
        const activity = report.activity
        const canManage = report.error === null
        /**
         * A hot install has no boot duration to show: the process started long
         * before this plugin existed. The panel says so instead of printing the
         * process uptime as if it were a startup cost.
         */
        const bootHot = boot.current?.hot === true
        /**
         * `complete` is written by the settle watcher of THIS Host build. Its
         * absence means the running Host half predates the panel — e.g. the
         * package was updated without a restart — and the number next to it is
         * whatever that older build called a duration. Refuse to print it.
         */
        const bootStaleHost = boot.current?.complete === undefined && !bootHot
        const bootNow = bootHot || bootStaleHost
          ? null
          : (Number.isFinite(boot.current?.settledMs) ? boot.current.settledMs : null)
        const stalled = Array.isArray(boot.current?.stalled) ? boot.current.stalled : []
        const measurable = Number.isFinite(totals.measuredBootMs)
        const thirdPartyBytes = Number.isFinite(totals.thirdPartyBytes) ? totals.thirdPartyBytes : totals.clientBytes

        const toggle = (plugin) => act(`toggle:${plugin.entryId}`, '/toggle',
          { entryId: plugin.entryId, enabled: plugin.enabled !== true },
          () => `${plugin.title} 已${plugin.enabled === true ? '停用' : '启用'}`)

        const quarantine = (plugin) => act(`clean:${plugin.entryId}`, '/quarantine',
          { entryId: plugin.entryId, reasons: (plugin.reasons ?? []).map((item) => item.code) },
          () => `${plugin.title} 已清理，可在「清理」页找回`)

        const restore = (item) => act(`restore:${item.entryId}`, '/restore', { entryId: item.entryId },
          (value) => {
            if (value?.present === true) return `${item.title ?? item.moduleName} 已回到组合`
            return `${item.title ?? item.moduleName} 已写回 profile patch，可能需要重启 DSH 才会加载`
          })

        /* -- tabs ------------------------------------------------------- */

        const tabs = [
          { id: 'overview', label: '概览' },
          { id: 'plugins', label: '插件', count: totals.plugins },
          { id: 'advice', label: '建议', count: suggestions.length },
          { id: 'startup', label: '启动开销' },
          { id: 'cleanup', label: '清理与找回', count: cleanup.broken.length + cleanup.disabled.length },
        ]

        const tabBar = h('div', { className: 'dspc-tabs' }, tabs.map((item) =>
          h('button', {
            key: item.id,
            type: 'button',
            className: 'dspc-tab',
            'data-active': tab === item.id ? 'true' : 'false',
            onClick: () => setTab(item.id),
          }, item.label,
          Number.isFinite(item.count) && item.count > 0
            ? h('span', { className: 'dspc-count' }, String(item.count))
            : null)))

        const bar = h('div', { className: 'dspc-bar' },
          h('div', { className: 'dspc-heading' },
            h('span', { className: 'dspc-title' }, '插件管家'),
            h('span', { className: 'dspc-sub' }, report.profile?.dir ?? '未识别 profile')),
          h('span', { className: 'dspc-grow' }),
          h(Chip, { tone: bootHot || bootStaleHost ? undefined : 'good' },
            bootHot ? '热安装' : bootStaleHost ? '重启后出数' : `启动 ${ms(bootNow)}`),
          h(Chip, null, `插件 ${String(totals.enabled ?? 0)}/${String(totals.plugins ?? 0)}`),
          totals.failed > 0 ? h(Chip, { tone: 'bad' }, `异常 ${String(totals.failed)}`) : null,
          h('button', {
            type: 'button', className: 'dspc-btn', disabled: busy !== '',
            onClick: () => {
              void load(false)
            },
          }, '刷新'))

        /* -- overview --------------------------------------------------- */

        const savedByAdvice = suggestions
          .filter((item) => item.verdict === 'disable')
          .reduce((sum, item) => sum + (Number(item.savedMs) || 0), 0)

        const overview = [
          h('div', { className: 'dspc-grid', key: 'grid' },
            h(Metric, {
              label: '本机启动总时长',
              value: bootHot || bootStaleHost ? '—' : ms(bootNow),
              note: bootHot
                ? '本插件是热安装的：本次进程启动早于它，重启后开始记录'
                : bootStaleHost
                  ? 'Host 半仍是旧版本：重启 DSH 后开始记录启动时长'
                  : '实测：进程启动 → 所有插件进入终态',
            }),
            h(Metric, {
              label: '插件模块冷加载合计',
              value: measurable ? ms(totals.measuredBootMs) : '未测量',
              note: measurable ? '实测：逐个子进程冷加载，3 次取最小' : '点「启动开销」页的测量按钮',
            }),
            h(Metric, {
              label: '第三方 UI 资源',
              value: kb(thirdPartyBytes),
              note: `实测文件大小；内置 client bundle 另有 ${kb((totals.clientBytes ?? 0) - thirdPartyBytes)}`,
            }),
            h(Metric, {
              label: '可停用建议',
              value: String(suggestions.filter((item) => item.verdict === 'disable').length),
              note: savedByAdvice > 0 ? `预计省 ${ms(savedByAdvice)} 冷加载` : '没有可量化的节省',
            }),
            h(Metric, {
              label: '可清理条目',
              value: String(cleanup.broken.length + cleanup.disabled.length),
              note: '加载失败 / 不兼容 / 已停用',
            }),
            h(Metric, {
              label: '活跃度窗口',
              value: activity === null ? '未扫描' : `${String(activity.windowDays)} 天`,
              note: activity === null
                ? '会话日志里的 tool/call 还没读过'
                : `${String(activity.sessionCount)} 个会话 · ${String(activity.toolCount)} 个工具被调用`
                  + (activity.coverage?.bytesBudgetExhausted === true ? ' · 已达解压预算，较早日志已完整计入' : ''),
            }),
            h(Metric, {
              label: '内置组件',
              value: String(totals.builtin ?? 0),
              note: totals.builtinFailed > 0
                ? `其中 ${String(totals.builtinFailed)} 个加载失败（不参与建议）`
                : 'DSH 自带，不参与停用/清理建议',
            })),

          h('div', { className: 'dspc-section', key: 'boot' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '启动记录（A/B 实测）'),
              h('span', { className: 'dspc-section-note' },
                '每次 DSH 启动记一条；组合变化时给出与上一次不同组合的差值')),
            h(Spark, { values: boot.history.map((item) => Number(item?.settledMs)).reverse() }),
            h('div', { className: 'dspc-note', style: { marginTop: '6px' } },
              boot.history.length === 0
                ? '还没有历史记录：本插件的第一次启动正在记录。'
                : `最近一次 ${clock(boot.history[0]?.at)} · ${ms(boot.history[0]?.settledMs)} · 启用 ${String(boot.history[0]?.enabledCount ?? 0)} 个`)),

          h('div', { className: 'dspc-section', key: 'actions' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '下一步可以做什么'),
              h('span', { className: 'dspc-section-note' }, '下面的按钮只读数据或只改本 profile 的组合')),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              h('button', {
                type: 'button', className: 'dspc-btn', 'data-primary': 'true',
                disabled: busy !== '' || jobs.activity?.state === 'running' || activity !== null,
                onClick: () => {
                  void act('activity', '/activity', { windowDays: 14 }, () => '活跃度扫描已开始，完成后这里会自动刷新')
                },
              }, jobs.activity?.state === 'running'
                ? '正在扫描活跃度…'
                : activity === null ? '扫描活跃度（会话日志）' : '重新扫描活跃度'),
              h('button', {
                type: 'button', className: 'dspc-btn',
                disabled: busy !== '' || jobs.bench?.state === 'running',
                onClick: () => {
                  void act('bench', '/measure', { force: false }, (value) => {
                    if (value?.started?.started === false) return '已在测量中'
                    return `开始测量 ${String(value?.started?.total ?? 0)} 个插件的冷加载开销`
                  })
                },
              }, jobs.bench?.state === 'running'
                ? `测量中 ${String(jobs.bench.done)}/${String(jobs.bench.total)}`
                : '测量冷加载开销'),
              h('button', {
                type: 'button', className: 'dspc-btn',
                disabled: busy !== '',
                onClick: () => setTab('advice'),
              }, `查看 ${String(suggestions.length)} 条建议`)),
            h('div', { className: 'dspc-note', style: { marginTop: '8px' } },
              '活跃度只统计会话日志中出现的 ',
              h('code', null, 'tool/call'),
              ' 事件；纯 UI 插件没有这条通道，会被标成「未观测」而不是「没用」。')),

          jobs.activity?.state === 'error'
            ? h('div', { className: 'dspc-notice', 'data-kind': 'error', key: 'job-error' }, jobs.activity.message)
            : null,
          stalled.length > 0
            ? h('div', { className: 'dspc-notice', 'data-kind': 'error', key: 'stalled' },
              `${String(stalled.length)} 个已启用条目启动后没进终态（停在 ${stalled.map((item) => item.phase ?? 'null').join(' / ')}）：`,
              stalled.slice(0, 6).map((item) => `${item.moduleName} `).join(''),
              stalled.length > 6 ? `… 共 ${String(stalled.length)} 个` : '',
              ' —— 它们等的服务没出现，可在「清理与找回」里处置。')
            : null,
          report.profile === null
            ? h('div', { className: 'dspc-notice', 'data-kind': 'error', key: 'no-profile' },
              'Host 未能识别 profile 目录，管理动作已禁用。')
            : null,
        ]

        /* -- plugins ---------------------------------------------------- */

        const needle = filter.trim().toLowerCase()
        const shown = needle === ''
          ? plugins
          : plugins.filter((plugin) =>
            String(plugin.title ?? '').toLowerCase().indexOf(needle) >= 0
            || String(plugin.moduleName ?? '').toLowerCase().indexOf(needle) >= 0)

        const pluginRow = (plugin) => {
          const verdict = VERDICT[plugin.verdict] ?? VERDICT.review
          const calls = plugin.activity === null ? null : plugin.activity.calls
          return h('div', { className: 'dspc-row dspc-cols-plugins', key: plugin.entryId },
            h('div', { className: 'dspc-name' },
              h('span', { className: 'dspc-name-main' }, plugin.title),
              h('span', { className: 'dspc-name-sub' },
                plugin.moduleName,
                plugin.version === null ? '' : ` · v${plugin.version}`)),
            h('span', { className: 'dspc-muted' }, KIND[plugin.kind] ?? plugin.kind),
            h('span', null,
              plugin.fiberPhase === 'failed'
                ? h(Badge, { tone: 'cleanup' }, '加载失败')
                : plugin.stalled === true
                  ? h(Badge, { tone: 'review' }, `卡住 ${String(plugin.stalledPhase ?? 'pending')}`)
                  : plugin.enabled ? h(Badge, { tone: 'keep' }, '启用') : h(Badge, { tone: 'idle' }, '停用')),
            h('span', { className: 'dspc-num' }, ms(plugin.bootMs)),
            h('span', { className: 'dspc-num' }, kb(plugin.client?.bytes ?? null)),
            h('span', { className: 'dspc-num' },
              calls === null ? h('span', { className: 'dspc-muted' }, '未扫描') : String(calls)),
            h('span', null, h(Badge, { tone: verdict.tone }, verdict.text)),
            h('span', { style: { textAlign: 'right' } },
              h('button', {
                type: 'button', className: 'dspc-btn', 'data-small': 'true',
                disabled: busy !== '' || canManage !== true || plugin.patchId === null,
                title: plugin.readOnlyReason === null
                  ? ''
                  : `这一行不能从 profile patch 修改：${plugin.readOnlyReason}`,
                onClick: () => {
                  void toggle(plugin)
                },
              }, busy === `toggle:${plugin.entryId}`
                ? '…'
                : plugin.enabled ? '停用' : '启用')))
        }

        const pluginsView = [
          h('div', { key: 'head', style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' } },
            h('input', {
              className: 'dspc-filter',
              placeholder: '按名称过滤',
              value: filter,
              onChange: (event) => setFilter(event.target.value),
            }),
            h('span', { className: 'dspc-section-note' },
              `${String(shown.length)} / ${String(plugins.length)} 个条目 · 冷加载 ${ms(totals.measuredBootMs)} · UI ${kb(totals.clientBytes)}`)),
          h('div', { className: 'dspc-rows', key: 'rows' },
            h('div', { className: 'dspc-row dspc-cols-plugins', 'data-head': 'true' },
              h('span', null, '插件'),
              h('span', null, '来源'),
              h('span', null, '状态'),
              h('span', { className: 'dspc-num' }, '冷加载'),
              h('span', { className: 'dspc-num' }, 'UI'),
              h('span', { className: 'dspc-num' }, '调用'),
              h('span', null, '判断'),
              h('span', { style: { textAlign: 'right' } }, '操作')),
            shown.length === 0
              ? h('div', { className: 'dspc-empty' }, '没有匹配的插件')
              : shown.map(pluginRow)),
          h('div', { className: 'dspc-note', key: 'note', style: { marginTop: '10px' } },
            '「调用」列是最近一个活跃度窗口内的 ',
            h('code', null, 'tool/call'),
            ' 次数；「未扫描」表示还没跑过扫描，不是 0。',
            pluginNote(plugins)),
        ]

        function pluginNote(list) {
          const readonly = list.filter((plugin) => plugin.patchId === null).length
          if (readonly === 0) return null
          return [h('br', { key: 'br' }),
            `${String(readonly)} 个条目不能从 profile patch 改动（预设/不可寻址），开关对它们无效。`]
        }

        /* -- advice ----------------------------------------------------- */

        const adviceList = suggestions.length === 0
          ? h('div', { className: 'dspc-empty' }, '没有需要处理的条目')
          : suggestions.map((item) => {
            const plugin = plugins.find((candidate) => candidate.entryId === item.entryId)
            const verdict = VERDICT[item.verdict] ?? VERDICT.review
            return h('div', { className: 'dspc-item', key: item.entryId },
              h('div', { className: 'dspc-item-head' },
                h('span', { className: 'dspc-item-title' }, item.title),
                h(Badge, { tone: verdict.tone }, verdict.text),
                Number.isFinite(item.savedMs)
                  ? h('span', { className: 'dspc-section-note' }, `冷加载 ${ms(item.savedMs)}`)
                  : null,
                h('div', { className: 'dspc-actions' },
                  plugin !== undefined && plugin.enabled === true
                    ? (confirming === `clean:${item.entryId}`
                      ? h('span', { className: 'dspc-confirm' },
                        '确认清理？',
                        h('button', {
                          type: 'button', className: 'dspc-btn', 'data-small': 'true', 'data-danger': 'true',
                          disabled: busy !== '',
                          onClick: () => {
                            void quarantine(plugin)
                          },
                        }, '确认'),
                        h('button', {
                          type: 'button', className: 'dspc-btn', 'data-small': 'true',
                          onClick: () => setConfirming(''),
                        }, '取消'))
                      : h('button', {
                        type: 'button', className: 'dspc-btn', 'data-small': 'true',
                        disabled: busy !== '',
                        onClick: () => {
                          if (item.verdict === 'cleanup') setConfirming(`clean:${item.entryId}`)
                          else void toggle(plugin)
                        },
                      }, item.verdict === 'cleanup' ? '清理' : '停用'))
                    : null)),
              item.reasons.length === 0
                ? null
                : h('ul', { className: 'dspc-reasons' }, item.reasons.map((reason, index) =>
                  h('li', { key: String(index) }, reason.text, ' ', h('code', null, reason.code)))))
          })

        const adviceView = [
          h('div', { className: 'dspc-note', key: 'note' },
            '判断规则全部来自实测字段，每条建议都附了触发它的字段名：',
            h('br'),
            '加载失败 / 版本不兼容 → 可清理；窗口内 0 次调用且没有 UI → 可停用；',
            '带 UI 但 0 次调用 → 待确认（UI 使用无法从日志观测）；已停用超过 14 天 → 可清理。',
            h('br'),
            `${String(totals.builtin ?? 0)} 个 DSH 内置组件不参与建议（它们的行通常不可寻址，停用也不是用户该做的决定）。`),
          h('div', { className: 'dspc-section', key: 'list' }, adviceList),
        ]

        /* -- startup ---------------------------------------------------- */

        const measured = plugins
          .filter((plugin) => Number.isFinite(plugin.bootMs))
          .sort((a, b) => b.bootMs - a.bootMs)
        const maxBoot = measured.length === 0 ? 0 : measured[0].bootMs
        const startupRows = measured.map((plugin) => h('div', { className: 'dspc-row dspc-cols-startup', key: plugin.entryId },
          h('div', { className: 'dspc-name' },
            h('span', { className: 'dspc-name-main' }, plugin.title),
            h('span', { className: 'dspc-name-sub' }, plugin.moduleName)),
          h('span', { className: 'dspc-num' }, ms(plugin.bootMs)),
          h('span', { className: 'dspc-bar-track' },
            h('span', {
              className: 'dspc-bar-fill',
              style: { width: `${String(maxBoot === 0 ? 0 : Math.max(2, Math.round((plugin.bootMs / maxBoot) * 100)))}%` },
            }))))

        const historyRows = boot.history.map((record) => h('div', { className: 'dspc-row dspc-cols-history', key: String(record.at) },
          h('span', { className: 'dspc-muted' }, clock(record.at)),
          h('span', { className: 'dspc-num' }, ms(record.settledMs)),
          h('span', { className: 'dspc-num' }, String(record.enabledCount ?? 0)),
          h('span', { className: 'dspc-muted', style: { fontVariantNumeric: 'tabular-nums' } }, String(record.fingerprint ?? '—')),
          h('span', {
            className: 'dspc-num',
            style: { color: record.changed === null ? undefined : (record.changed.deltaMs > 0 ? '#b42318' : '#12703f') },
          }, record.changed === null
            ? h('span', { className: 'dspc-muted' }, '组合未变')
            : `${signed(record.changed.deltaMs)} · ${record.changed.entryCount > 0 ? '+' : ''}${String(record.changed.entryCount)} 个`)))

        const startupView = [
          h('div', { className: 'dspc-section', key: 'basis' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '三个不同的数字，三套测量方法'),
              h('span', { className: 'dspc-section-note' }, '不要把它们相加成一个「总开销」')),
            h('div', { className: 'dspc-note' },
              h('div', null,
                `本机启动：${ms(bootNow)} — ${String(boot.basis?.settledMs ?? '')}`,
                boot.current?.complete === 'terminal'
                  ? '（所有条目都到了终态）'
                  : boot.current?.complete === 'stable'
                    ? `（相位稳定后停止；${String(stalled.length)} 个条目始终没进终态）`
                    : boot.current?.complete === 'timeout' ? '（等待超时）' : ''),
              h('div', null, `插件冷加载：${ms(totals.measuredBootMs)} — ${String(boot.basis?.bootMs ?? '')}`),
              h('div', null,
                'UI 资源：每个插件用自己的 client bundle 大小表示 — ',
                '浏览器侧的实际耗时由本面板在页面加载时从 Resource Timing 读回（「UI 耗时」列出现时才是浏览器实测）。'),
              h('div', null,
                '子进程探针只 import 模块、不执行 apply()，所以 apply() 里干的活不计入这一列；',
                '它体现在「本机启动」里，并通过 A/B 历史记录看到组合变化带来的差值。'),
              h('div', null,
                `内置组件（${String(totals.builtin ?? 0)} 个）不测冷加载：它们在 app.asar 内，`,
                '纯 node 子进程读不了那个归档。面板把它们记为「不可测」，而不是 0 ms。'))),

          h('div', { className: 'dspc-section', key: 'measure' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '逐插件冷加载'),
              h('span', { className: 'dspc-section-note' },
                jobs.bench?.state === 'running'
                  ? `${String(jobs.bench.done)}/${String(jobs.bench.total)} · ${jobs.bench.current}`
                  : '单位 ms · 越小越好')),
            h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } },
              h('button', {
                type: 'button', className: 'dspc-btn', 'data-primary': 'true',
                disabled: busy !== '' || jobs.bench?.state === 'running',
                onClick: () => {
                  void act('bench', '/measure', { force: true }, () => '开始重新测量（忽略缓存）')
                },
              }, jobs.bench?.state === 'running' ? '测量中…' : '重新测量全部'),
              h('span', { className: 'dspc-section-note' },
                jobs.bench?.state === 'running'
                  ? `${String(jobs.bench.done)}/${String(jobs.bench.total)} · ${String(jobs.bench.current)}`
                  : measured.length === 0
                    ? '还没测量'
                    // Counted from the rows that actually carry a number, not from
                    // the job's own message: a plugin whose probe failed has no
                    // cold-load time and must not be counted as measured.
                    : `已实测 ${String(measured.length)} 个插件，合计 ${ms(totals.measuredBootMs)}；取 3 次最小值`
                      + (typeof jobs.bench?.launcher === 'string' ? ' · 探针 ' + jobs.bench.launcher.split(/[\\/]/).pop() : ''))),
            h('div', { className: 'dspc-rows' },
              measured.length === 0
                ? h('div', { className: 'dspc-empty' }, '还没有测量结果')
                : startupRows)),

          h('div', { className: 'dspc-section', key: 'history' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '启动历史与 A/B 差值'),
              h('span', { className: 'dspc-section-note' }, '同一组合内不比较；组合指纹变了才给差值')),
            h('div', { className: 'dspc-rows' },
              h('div', { className: 'dspc-row dspc-cols-history', 'data-head': 'true' },
                h('span', null, '启动时间'),
                h('span', { className: 'dspc-num' }, '总时长'),
                h('span', { className: 'dspc-num' }, '启用数'),
                h('span', null, '组合指纹'),
                h('span', { className: 'dspc-num' }, '与上次不同组合相比')),
              historyRows.length === 0
                ? h('div', { className: 'dspc-empty' }, '还没有历史记录')
                : historyRows)),
        ]

        /* -- cleanup --------------------------------------------------- */

        const cleanupRow = (plugin, action) => {
          const verdict = VERDICT[plugin.verdict] ?? VERDICT.review
          const key = `clean:${plugin.entryId}`
          return h('div', { className: 'dspc-row dspc-cols-startup', key: plugin.entryId },
            h('div', { className: 'dspc-name' },
              h('span', { className: 'dspc-name-main' }, plugin.title),
              h('span', { className: 'dspc-name-sub' },
                plugin.moduleName,
                plugin.error?.code === undefined ? '' : ` · ${String(plugin.error.code)}`)),
            h('span', null, h(Badge, { tone: verdict.tone }, verdict.text)),
            h('span', { style: { textAlign: 'right' } },
              confirming === key
                ? h('span', { className: 'dspc-confirm' },
                  '确认？',
                  h('button', {
                    type: 'button', className: 'dspc-btn', 'data-small': 'true', 'data-danger': 'true',
                    disabled: busy !== '',
                    onClick: () => {
                      void quarantine(plugin)
                    },
                  }, '确认'),
                  h('button', {
                    type: 'button', className: 'dspc-btn', 'data-small': 'true',
                    onClick: () => setConfirming(''),
                  }, '取消'))
                : h('button', {
                  type: 'button', className: 'dspc-btn', 'data-small': 'true',
                  disabled: busy !== '',
                  onClick: () => setConfirming(key),
                }, action)))
        }

        const trashRows = cleanup.trash.map((item) => h('div', { className: 'dspc-row dspc-cols-startup', key: item.entryId },
          h('div', { className: 'dspc-name' },
            h('span', { className: 'dspc-name-main' }, item.title ?? item.moduleName),
            h('span', { className: 'dspc-name-sub' },
              item.moduleName,
              ' · ',
              clock(item.at),
              ' 清理',
              item.live === null ? ' · 已不在 Loader 树' : '')),
          h('span', null, h(Badge, { tone: 'idle' }, item.live === null ? '待找回' : '已停用')),
          h('span', { style: { textAlign: 'right' } },
            h('button', {
              type: 'button', className: 'dspc-btn', 'data-small': 'true', 'data-primary': 'true',
              disabled: busy !== '',
              onClick: () => {
                void restore(item)
              },
            }, busy === `restore:${item.entryId}` ? '…' : '找回'))))

        const cleanupView = [
          h('div', { className: 'dspc-section', key: 'broken' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '不兼容 / 加载失败 / 启动卡住'),
              h('span', { className: 'dspc-section-note' },
                '这些条目占着启动时间却不可用；清理会停用并记入回收站')),
            h('div', { className: 'dspc-rows' },
              cleanup.broken.length === 0
                ? h('div', { className: 'dspc-empty' }, '没有加载失败或不兼容的条目')
                : cleanup.broken.map((plugin) => cleanupRow(plugin, '清理')))),

          h('div', { className: 'dspc-section', key: 'disabled' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '已停用（仍在组合里）'),
              h('span', { className: 'dspc-section-note' }, '停用不占启动，但会留在 patch 中；清理给它们进入回收站')),
            h('div', { className: 'dspc-rows' },
              cleanup.disabled.length === 0
                ? h('div', { className: 'dspc-empty' }, '没有已停用的条目')
                : cleanup.disabled.map((plugin) => cleanupRow(plugin, '清理')))),

          h('div', { className: 'dspc-section', key: 'trash' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '回收站 · 可找回'),
              h('span', { className: 'dspc-section-note' },
                '找回 = 重新启用；若该行已从 patch 中消失，则写回一条 insert 行（自动备份 patch）')),
            h('div', { className: 'dspc-rows' },
              trashRows.length === 0
                ? h('div', { className: 'dspc-empty' }, '回收站是空的')
                : trashRows)),

          cleanup.history.length === 0 ? null : h('div', { className: 'dspc-section', key: 'history' },
            h('div', { className: 'dspc-section-head' },
              h('span', { className: 'dspc-section-title' }, '最近找回'),
              h('span', { className: 'dspc-section-note' }, '只保留最近 20 条')),
            h('div', { className: 'dspc-note' },
              cleanup.history.map((item, index) => h('div', { key: String(index) },
                `${clock(item.restoredAt)} · ${item.moduleName ?? item.entryId}`)))),
        ]

        const views = {
          overview,
          plugins: pluginsView,
          advice: adviceView,
          startup: startupView,
          cleanup: cleanupView,
        }

        return h('div', { className: 'dspc-root' },
          bar,
          tabBar,
          error !== null ? h('div', { className: 'dspc-notice', 'data-kind': 'error', role: 'alert' }, error) : null,
          notice !== null
            ? h('div', { className: 'dspc-notice', 'data-kind': notice.kind === 'ok' ? 'ok' : undefined, role: 'status' }, notice.text)
            : null,
          report.lastError !== null && report.lastError !== undefined
            ? h('div', { className: 'dspc-notice', 'data-kind': 'error' }, `Host 记录的最后一个错误：${String(report.lastError)}`)
            : null,
          h('div', { className: 'dspc-body' }, views[tab] ?? overview))
      }

      /**
       * Module names a Plugins-page `subject` stands for.
       *
       * The shipped page passes one of three shapes (verified against its client
       * bundle): `{ kind: 'row', pkg, row }`, `{ kind: 'bundle', pkg }` where
       * `pkg.rows` lists the bundle's rows, and `{ kind: 'package', name }` for an
       * official entry that has no Loader row at all.
       */
      function moduleNamesOf(subject) {
        if (subject === null || typeof subject !== 'object') return []
        if (subject.kind === 'row') {
          const name = subject.row?.moduleName
          return typeof name === 'string' ? [name] : []
        }
        if (subject.kind === 'bundle' || subject.kind === 'package') {
          const rows = subject.pkg?.rows
          if (!Array.isArray(rows)) return []
          return rows.map((row) => row?.moduleName).filter((name) => typeof name === 'string')
        }
        return []
      }

      /** The report entries one Plugins-page subject belongs to. */
      function matchSubject(subject, plugins) {
        const names = moduleNamesOf(subject)
        const rowId = subject?.kind === 'row' && typeof subject.row?.rowId === 'string' ? subject.row.rowId : null
        if (names.length === 0 && rowId === null) return []
        return plugins.filter((plugin) =>
          names.includes(plugin.moduleName) || (rowId !== null && plugin.patchId === rowId))
      }

      const VERDICT_ORDER = { cleanup: 0, disable: 1, review: 2, idle: 3, keep: 4 }

      /**
       * The curator's facts on ONE plugin's own page.
       *
       * It reuses the same `/report` the tab reads, matches the page's subject to
       * Loader entries by module name (or patch row id), and renders nothing when
       * the subject is not a composed plugin — the slot's contract is that an
       * entry draws nothing for a subject it has nothing for.
       */
      function CuratorDetail(props) {
        const subject = props?.subject
        const [report, setReport] = React.useState(null)
        const [busy, setBusy] = React.useState('')
        const [notice, setNotice] = React.useState(null)

        const load = React.useCallback(async () => {
          const result = await postJson('/report', {})
          if (result.ok && result.payload?.ok === true) setReport(result.payload.value)
        }, [])

        React.useEffect(() => {
          void load()
        }, [load, subject?.kind, subject?.pkg?.name, subject?.row?.rowId])

        if (report === null) return null
        const matched = matchSubject(subject, Array.isArray(report.plugins) ? report.plugins : [])
        if (matched.length === 0) return null

        const act = async (key, path, body, text) => {
          setBusy(key)
          setNotice(null)
          const result = await postJson(path, body)
          setBusy('')
          if (!result.ok || result.payload?.ok !== true) {
            setNotice({ kind: 'error', text: result.payload?.error ?? '操作失败' })
            return
          }
          setNotice({ kind: 'ok', text })
          await load()
        }

        const worst = matched.reduce((current, plugin) =>
          (VERDICT_ORDER[plugin.verdict] ?? 9) < (VERDICT_ORDER[current.verdict] ?? 9) ? plugin : current, matched[0])
        const verdict = VERDICT[worst.verdict] ?? VERDICT.review
        const bootMs = matched.reduce((sum, plugin) => sum + (Number(plugin.bootMs) || 0), 0)
        const bytes = matched.reduce((sum, plugin) => sum + (Number(plugin.client?.bytes) || 0), 0)
        const scanned = matched.some((plugin) => plugin.activity !== null)
        const calls = matched.reduce((sum, plugin) => sum + (Number(plugin.activity?.calls) || 0), 0)
        const reasons = matched.flatMap((plugin) => plugin.reasons ?? [])
        const single = matched.length === 1 ? matched[0] : null
        const toggleable = single !== null && single.patchId !== null

        return h('div', { className: 'dspc-detail' },
          h('div', { className: 'dspc-detail-head' },
            h('span', { className: 'dspc-detail-title' }, '插件管家 · 实测'),
            h(Badge, { tone: verdict.tone }, verdict.text),
            single !== null && single.stalled === true
              ? h(Badge, { tone: 'review' }, `卡住 ${String(single.stalledPhase ?? 'pending')}`)
              : null),
          h('div', { className: 'dspc-detail-grid' },
            h('div', { className: 'dspc-detail-cell' }, '冷加载', h('b', null, ms(bootMs))),
            h('div', { className: 'dspc-detail-cell' }, 'UI 资源', h('b', null, kb(bytes))),
            h('div', { className: 'dspc-detail-cell' }, '窗口内调用', h('b', null, scanned ? String(calls) : '未扫描')),
            h('div', { className: 'dspc-detail-cell' }, '条目', h('b', null, String(matched.length)))),
          reasons.length === 0
            ? null
            : h('div', { className: 'dspc-detail-note' },
              reasons.slice(0, 4).map((reason, index) =>
                h('div', { key: String(index) }, reason.text, ' ', h('code', null, reason.code)))),
          h('div', { className: 'dspc-detail-actions' },
            toggleable
              ? h('button', {
                type: 'button', className: 'dspc-btn', 'data-small': 'true',
                disabled: busy !== '',
                onClick: () => {
                  void act('toggle', '/toggle', { entryId: single.entryId, enabled: single.enabled !== true },
                    `已${single.enabled === true ? '停用' : '启用'}`)
                },
              }, single.enabled === true ? '停用' : '启用')
              : null,
            single !== null && single.enabled === true && (single.verdict === 'cleanup' || single.verdict === 'disable')
              ? h('button', {
                type: 'button', className: 'dspc-btn', 'data-small': 'true', 'data-danger': 'true',
                disabled: busy !== '',
                onClick: () => {
                  void act('quarantine', '/quarantine', {
                    entryId: single.entryId,
                    reasons: (single.reasons ?? []).map((item) => item.code),
                  }, '已清理，可在「插件管家」页找回')
                },
              }, '清理')
              : null,
            notice !== null
              ? h('span', { className: 'dspc-detail-note', style: { marginTop: '0' },
                role: notice.kind === 'ok' ? 'status' : 'alert',
                'data-kind': notice.kind }, notice.text)
              : null))
      }

      return {
        name: 'dsh-plugin-curator-client',
        inject: ['slots'],
        apply(ctx) {
          ensureStyles()
          // Both registrations live inside the shipped Plugins page and are
          // disposed with this plugin's fiber, so a reload leaves no stale tab.
          ctx.effect(() => {
            const disposeTab = ctx.slots.inject('plugins.tab', () => ctx.slots.register(
              { name: 'plugins.tab', id: TAB_ID, order: 10, label: () => '插件管家' },
              CuratorPage,
            ))
            const disposeDetail = ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(
              { name: 'plugins.detail.section', id: DETAIL_ID, order: 10, label: () => '插件管家' },
              CuratorDetail,
            ))
            return () => {
              if (typeof disposeTab === 'function') disposeTab()
              if (typeof disposeDetail === 'function') disposeDetail()
            }
          }, 'plugin-curator: plugins-page registrations')
        },
      }
    },
  })
})()
