// Light or dark: the choice made with the header's button, kept in this browser; the system's
// setting until then. Loaded in <head>, so the page never paints in the wrong theme.
(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const stored = () => {
    try {
      return localStorage.getItem('theme');
    } catch {
      return null;
    }
  };
  const apply = () => {
    root.dataset.theme = stored() ?? (system.matches ? 'dark' : 'light');
  };
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.theme')) return;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Private window or storage off: the choice lasts until the next page.
    }
    root.dataset.theme = next;
  });
})();
