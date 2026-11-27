/**
 * Shared responsive layout tokens.
 *
 * These values mirror the CSS custom properties defined in index.css.
 * Use the CSS classes (.page-container, .content-narrow, etc.) where possible.
 * Import these constants for the rare cases where inline styles are unavoidable.
 */

export const PAGE_MAX_WIDTH = '1200px';

/** Horizontal padding at each major breakpoint. */
export const PAGE_PADDING = {
  sm: '0.75rem',  // < 375 px
  base: '1rem',   // 320 – 767 px
  md: '2rem',     // 768 px +
  xl: '3rem',     // 1280 px +
};

/**
 * Shared page wrapper style (inline-style fallback).
 * Prefer the .page-container + .content-* CSS classes instead.
 */
export const pageStyle = {
  width: '100%',
  maxWidth: PAGE_MAX_WIDTH,
  marginInline: 'auto',
  paddingInline: PAGE_PADDING.base,
  boxSizing: 'border-box',
};

/**
 * Narrow content column (forms, single-record views) — max 500 px.
 */
export const narrowContentStyle = {
  ...pageStyle,
  maxWidth: '500px',
};

/**
 * Medium content column (dashboards, lists) — max 700 px.
 */
export const mediumContentStyle = {
  ...pageStyle,
  maxWidth: '700px',
};
