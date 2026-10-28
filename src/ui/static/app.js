// Every 5 s, fetch this page again and swap <main> when it changed. Not while the tab is hidden,
// and not while the search box has focus. A comment opened in a bug's history stays open.
// Everything else is plain links and forms.
setInterval(async () => {
  if (document.hidden || document.activeElement?.matches('input')) return;
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
