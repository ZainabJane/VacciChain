import { useEffect, useState } from 'react';

function getStoredPreference() {
  try {
    const stored = localStorage.getItem('darkMode');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    // Storage unavailable; fall through to OS preference.
  }
  return null;
}

function getSystemPreference() {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
  } catch (e) {
    // matchMedia unavailable; default to light.
  }
  return false;
}

function getInitialDark() {
  const stored = getStoredPreference();
  if (stored !== null) return stored;
  return getSystemPreference();
}

function applyTheme(dark) {
  try {
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    // Ignore DOM errors.
  }
}

function persistPreference(dark) {
  try {
    localStorage.setItem('darkMode', String(dark));
  } catch (e) {
    // Storage unavailable; ignore.
  }
}

export function useDarkMode() {
  const [dark, setDark] = useState(getInitialDark);

  useEffect(() => {
    applyTheme(dark);
    persistPreference(dark);
  }, [dark]);

  return [dark, setDark];
}