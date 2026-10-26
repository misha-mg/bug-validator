// Every 5 s, fetch this page again and swap <main> when it changed. Not while the tab is hidden,
// and not while the search box has focus. Everything else is plain links and forms.
setInterval(async () => {
  if (document.hidden || document.activeElement?.matches('input')) return;
  try {
    const html = await (await fetch(location.href, { cache: 'no-store' })).text();
    const next = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
    const main = document.querySelector('main');
    if (next && main && next.innerHTML !== main.innerHTML) main.innerHTML = next.innerHTML;
  } catch {
    // The UI is restarting; the next tick tries again.
  }
}, 5000);
