import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';

const SUPPORTED_LOCALES = ['en', 'fr'];
const DEFAULT_LOCALE = 'en';

function safeGetStoredLanguage() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) {
      return null;
    }
    return localStorage.getItem('lang');
  } catch (e) {
    return null;
  }
}

function resolveLocale(locale) {
  if (typeof locale === 'string' && locale.length > 0) {
    return locale;
  }
  try {
    const active = i18n && i18n.language;
    if (typeof active === 'string' && active.length > 0) {
      return active;
    }
  } catch (e) {
    // ignore
  }
  return DEFAULT_LOCALE;
}

function toDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else {
    return null;
  }
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

export function formatDate(value, locale) {
  const resolvedLocale = resolveLocale(locale);
  const date = toDate(value);
  if (!date) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat(resolvedLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch (e) {
    try {
      return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(date);
    } catch (err) {
      return '';
    }
  }
}

export function formatNumber(value, locale, options) {
  const resolvedLocale = resolveLocale(locale);
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) {
    return '';
  }
  try {
    return new Intl.NumberFormat(resolvedLocale, options).format(numeric);
  } catch (e) {
    try {
      return new Intl.NumberFormat(DEFAULT_LOCALE, options).format(numeric);
    } catch (err) {
      return String(numeric);
    }
  }
}

function getPluralCategory(count, locale) {
  const resolvedLocale = resolveLocale(locale);
  const numeric = typeof count === 'number' ? count : Number(count);
  const safeCount = Number.isNaN(numeric) ? 0 : numeric;
  try {
    return new Intl.PluralRules(resolvedLocale).select(safeCount);
  } catch (e) {
    try {
      return new Intl.PluralRules(DEFAULT_LOCALE).select(safeCount);
    } catch (err) {
      return safeCount === 1 ? 'one' : 'other';
    }
  }
}

export function formatCount(count, locale, key, t) {
  const resolvedLocale = resolveLocale(locale);
  const numeric = typeof count === 'number' ? count : Number(count);
  const safeCount = Number.isNaN(numeric) ? 0 : numeric;
  const translate = typeof t === 'function' ? t : i18n.t.bind(i18n);
  const category = getPluralCategory(safeCount, resolvedLocale);

  const pluralKey = `${key}_${category}`;
  const options = { count: safeCount, lng: resolvedLocale };

  try {
    const pluralResult = translate(pluralKey, options);
    if (typeof pluralResult === 'string' && pluralResult !== pluralKey) {
      return pluralResult;
    }
  } catch (e) {
    // fall through
  }

  try {
    return translate(key, options);
  } catch (e) {
    return String(safeCount);
  }
}

export { SUPPORTED_LOCALES, DEFAULT_LOCALE };

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: safeGetStoredLanguage() || DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  interpolation: { escapeValue: false },
});

export default i18n;