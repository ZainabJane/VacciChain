// Shared responsive layout utilities for the VacciChain frontend.
//
// Every dashboard and verification page imports from this module so
// page-width, spacing, and breakpoint rules are defined in one place and
// applied consistently across 320px, 768px, and desktop viewports.

export const breakpoints = {
  phone: '320px',
  tablet: '768px',
  desktop: '1024px',
};

export const spacing = {
  xs: '0.5rem',
  sm: '1rem',
  md: '1.5rem',
  lg: '2rem',
  xl: '3rem',
};

/* Responsive page padding — 1rem on phones, 1.5rem on tablet+. */
export const pagePadding = {
  paddingLeft: 'var(--page-padding)',
  paddingRight: 'var(--page-padding)',
};

/* Shared page container: full width, capped max-width, centered, no
 * horizontal overflow at any breakpoint. */
export const pageContainer = {
  width: '100%',
  maxWidth: 'var(--container-default)',
  margin: '0 auto',
  boxSizing: 'border-box',
  ...pagePadding,
};

/* Narrower container used by single-column forms (issuer, onboarding). */
export const pageContainerNarrow = {
  ...pageContainer,
  maxWidth: 'var(--container-narrow)',
};

/* Wider container used by analytics. */
export const pageContainerWide = {
  ...pageContainer,
  maxWidth: 'var(--container-wide)',
};

/* Section spacing between content blocks. */
export const section = {
  marginBottom: spacing.md,
};

/* Top-level page wrapper with vertical rhythm. */
export const page = {
  ...pageContainer,
  marginTop: spacing.lg,
  marginBottom: spacing.lg,
};

/* Responsive nav link row: wraps on small screens. */
export const navLinks = {
  display: 'flex',
  gap: spacing.sm,
  alignItems: 'center',
  flexWrap: 'wrap',
};

/* Focus-visible ring reused by interactive components. */
export const focusRing = {
  outline: '3px solid var(--focus-ring)',
  outlineOffset: '3px',
};
