try {
  const saved = localStorage.getItem('being-docs-theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
} catch {}
