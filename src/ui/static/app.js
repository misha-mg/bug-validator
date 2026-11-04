// Every 5 s, fetch this page again and swap <main> when it changed. Not while the tab is hidden,
// the search box has focus or a confirmation is open. A comment opened in a bug's history stays
// open. A link with data-dialog opens its confirmation as a modal (without JavaScript it opens
// the page with the confirmation shown); its data-close link closes it. Everything else is plain
// links and forms.
setInterval(async () => {
  if (document.hidden || document.activeElement?.matches('input') || document.querySelector('dialog[open]')) return;
  try {
    const html = await (await fetch(location.href, { cache: 'no-store' })).text();
    const next = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
    const main = document.querySelector('main');
    if (!next || !main || next.innerHTML === main.innerHTML) return;
    const open = [...main.querySelectorAll('details')].map((d) => d.open);
    main.innerHTML = next.innerHTML;
    main.querySelectorAll('details').forEach((d, i) => {
      if (open[i]) d.open = true;
    });
  } catch {
    // The UI is restarting; the next tick tries again.
  }
}, 5000);

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-dialog], [data-close]');
  if (!link) return;
  event.preventDefault();
  if (link.matches('[data-close]')) link.closest('dialog')?.close();
  else document.getElementById(link.dataset.dialog)?.showModal();
});
