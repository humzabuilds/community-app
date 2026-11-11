// Small progressive enhancements. Every feature works without this file.
(function () {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

  // Copy buttons on prompt and code blocks.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.innerText);
    } catch {
      const r = document.createRange();
      r.selectNodeContents(code);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.execCommand('copy');
      s.removeAllRanges();
    }
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1600);
  });

  // Confirm destructive actions.
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-confirm]');
    if (f && !confirm(f.getAttribute('data-confirm'))) e.preventDefault();
  });

  // Likes without a page reload.
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-like]');
    if (!f || e.defaultPrevented) return;
    e.preventDefault();
    const btn = f.querySelector('button');
    try {
      const res = await fetch(f.action, { method: 'POST', headers: { Accept: 'application/json', 'X-CSRF-Token': csrf }, credentials: 'same-origin' });
      const data = await res.json();
      if (!data.ok) return;
      btn.classList.toggle('liked', data.liked);
      btn.setAttribute('aria-pressed', String(data.liked));
      btn.querySelector('svg')?.setAttribute('fill', data.liked ? 'currentColor' : 'none');
      const n = btn.querySelector('[data-count]');
      if (n) n.textContent = data.count;
    } catch {
      f.submit();
    }
  });

  // Close open menus when clicking elsewhere.
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
