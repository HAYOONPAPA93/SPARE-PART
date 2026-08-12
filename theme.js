(function (global) {
  const KEY = 'spare-parts-theme';

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') || localStorage.getItem(KEY) || 'light';
  }

  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(KEY, t);
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      const toDark = t !== 'dark';
      btn.setAttribute('aria-label', toDark ? '다크 모드로 전환' : '라이트 모드로 전환');
      btn.title = btn.getAttribute('aria-label');
    });
  }

  function toggleTheme() {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
    global.dispatchEvent(new CustomEvent('spareparts-theme-change', { detail: { theme: getTheme() } }));
  }

  function initTheme() {
    applyTheme(localStorage.getItem(KEY) || 'light');
  }

  function bindToggles() {
    applyTheme(getTheme());
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      if (btn.dataset.themeBound) return;
      btn.dataset.themeBound = '1';
      btn.addEventListener('click', toggleTheme);
    });
  }

  global.SparePartsTheme = { KEY, getTheme, applyTheme, toggleTheme, initTheme, bindToggles };
})(window);
