// The console's few behaviours on the server-rendered pages; everything works without this file,
// minus the refresh, the toasts, the fold and the chart's tooltip.
//
// Every 5 s, fetch this page again and swap <main> when it changed: not while the tab is hidden,
// the search box has focus or a confirmation is open. A comment opened in a bug's history stays
// open, and the state sources stay folded or not as they were.
setInterval(async () => {
  if (document.hidden || document.activeElement?.matches('input') || document.querySelector('dialog[open]')) return
  try {
    const html = await (await fetch(location.href, { cache: 'no-store' })).text()
    const next = new DOMParser().parseFromString(html, 'text/html').querySelector('main')
    const main = document.querySelector('main')
    if (!next || !main || next.innerHTML === main.innerHTML) return
    const open = [...main.querySelectorAll('details')].map((d) => d.open)
    main.innerHTML = next.innerHTML
    main.querySelectorAll('details').forEach((d, i) => {
      if (open[i]) d.open = true
    })
    foldSources()
  } catch {
    // The UI is restarting; the next tick tries again.
  }
}, 5000)

// The state sources fold to a lamp and a word. Whether they are open is remembered in this
// browser; until a choice is made they are open while a source is not OK. A click anywhere on
// the frame folds or unfolds; the server renders them open, so a page without JavaScript shows all.
const SOURCES_OPEN = 'bug-validator.sources-open'
const stored = (key) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function foldSources(toggle = false) {
  const frame = document.querySelector('.sources')
  if (!frame) return
  let open = stored(SOURCES_OPEN) === null ? frame.dataset.ok !== '1' : stored(SOURCES_OPEN) === '1'
  if (toggle) {
    open = !open
    try {
      localStorage.setItem(SOURCES_OPEN, open ? '1' : '0')
    } catch {
      // Private window or storage off: the choice lasts until the next page.
    }
  }
  frame.querySelector('.deps').hidden = !open
  frame.querySelector('.fold').setAttribute('aria-expanded', String(open))
  frame.querySelector('.chevron').textContent = open ? '−' : '+'
}
foldSources()

// A link with data-dialog opens its confirmation as a modal (without JavaScript it opens the
// page with the confirmation shown); its data-close link closes it. A click on the sources frame
// folds it. Everything else is plain links and forms.
document.addEventListener('click', (event) => {
  if (event.target.closest?.('.sources')) return foldSources(true)
  const link = event.target.closest?.('a[data-dialog], [data-close]')
  if (!link) return
  event.preventDefault()
  if (link.matches('[data-close]')) link.closest('dialog')?.close()
  else document.getElementById(link.dataset.dialog)?.showModal()
})

// A notification after a POST comes in the URL (?toast=kind:text) and, for a page without
// JavaScript, as a notice at the top of <main>. Here the notice becomes a toast of the sheet at the
// bottom right, the parameter leaves the URL, and the toast leaves by itself after its time
// (held while the pointer is over it) or on ×.
const LIFETIME = { info: 5000, success: 7000, error: 8000 }
const ICONS = { info: 'i', success: '✓', error: '!' }
function toastFromUrl() {
  const notice = document.querySelector('main > .notice[data-toast]')
  if (!notice) return
  const kind = notice.dataset.toast
  const text = notice.textContent
  notice.remove()
  const url = new URL(location.href)
  url.searchParams.delete('toast')
  history.replaceState(null, '', url)
  const stack =
    document.querySelector('.toasts') ?? document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toasts' }))
  const toast = document.createElement('div')
  toast.className = `toast ${kind}`
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  toast.style.setProperty('--life', `${LIFETIME[kind]}ms`)
  toast.innerHTML =
    '<span class="icon" aria-hidden="true"></span><div class="body"><div class="title"></div></div><button class="close" type="button" aria-label="Close">×</button><span class="life"></span>'
  toast.querySelector('.icon').textContent = ICONS[kind]
  toast.querySelector('.title').textContent = text
  stack.appendChild(toast)
  // The bar under the toast shows the time left; the pointer over it holds both.
  let left = LIFETIME[kind]
  let endsAt = Date.now() + left
  let timer = setTimeout(() => toast.remove(), left)
  toast.addEventListener('mouseenter', () => {
    clearTimeout(timer)
    left = Math.max(800, endsAt - Date.now())
  })
  toast.addEventListener('mouseleave', () => {
    endsAt = Date.now() + left
    timer = setTimeout(() => toast.remove(), left)
  })
  toast.querySelector('.close').addEventListener('click', () => {
    clearTimeout(timer)
    toast.remove()
  })
}
toastFromUrl()

// The column chart's tooltip: the pointer over a column's hit rect shows the day and each
// series' count (from the rect's data-* and the legend), with a band under the column.
document.addEventListener('mouseover', (event) => {
  const hit = event.target.closest?.('.columns .hit')
  const plot = event.target.closest?.('.columns .plot')
  if (!plot) return
  plot.querySelector('.tip')?.remove()
  plot.querySelector('.band')?.remove()
  if (!hit) return
  const svg = plot.querySelector('svg')
  const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  band.setAttribute('class', 'band')
  band.setAttribute('x', hit.getAttribute('x'))
  band.setAttribute('width', hit.getAttribute('width'))
  band.setAttribute('y', svg.dataset.top)
  band.setAttribute('height', svg.dataset.plotHeight)
  svg.insertBefore(band, svg.querySelector('.cols'))
  const tip = document.createElement('div')
  tip.className = 'tip'
  const when = document.createElement('div')
  when.className = 'when'
  when.textContent = `${hit.dataset.when} · ${hit.dataset.total}`
  tip.appendChild(when)
  const values = hit.dataset.values.split(',')
  plot
    .closest('.columns')
    .querySelectorAll('.legend li')
    .forEach((li, i) => {
      const row = document.createElement('div')
      row.className = 'row'
      row.innerHTML = '<i></i><span></span><b></b>'
      row.querySelector('i').style.background = li.querySelector('i').style.background
      row.querySelector('span').textContent = li.textContent
      row.querySelector('b').textContent = values[i] ?? '0'
      tip.appendChild(row)
    })
  const box = hit.getBoundingClientRect()
  const area = plot.getBoundingClientRect()
  const centre = box.left + box.width / 2 - area.left
  tip.style.left = `${Math.min(Math.max(centre, 90), area.width - 90)}px`
  plot.appendChild(tip)
})
document.addEventListener(
  'mouseleave',
  (event) => {
    if (event.target instanceof Element && event.target.matches?.('.columns .plot')) {
      event.target.querySelector('.tip')?.remove()
      event.target.querySelector('.band')?.remove()
    }
  },
  true,
)
