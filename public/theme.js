export const THEMES = Object.freeze({
  modern: 'Modern',
  classic: 'Classic Translator 1998',
});

const STORAGE_KEY = 'legenda-livre-theme';

export function normalizeTheme(value) {
  return Object.hasOwn(THEMES, value) ? value : 'modern';
}

export function applyTheme(value) {
  const theme = normalizeTheme(value);
  document.documentElement.dataset.theme = theme;
  for (const select of document.querySelectorAll('[data-theme-select]')) {
    select.value = theme;
  }
  return theme;
}

export function initTheme() {
  let saved = 'modern';
  try {
    saved = localStorage.getItem(STORAGE_KEY) || 'modern';
  } catch {
    // Storage can be unavailable in hardened browser/OBS profiles.
  }
  const requested = new URLSearchParams(location.search).get('theme');
  if (requested) saved = requested;
  applyTheme(saved);
  for (const select of document.querySelectorAll('[data-theme-select]')) {
    select.addEventListener('change', () => {
      const theme = applyTheme(select.value);
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // The selected theme still applies for the current page.
      }
    });
  }
}
