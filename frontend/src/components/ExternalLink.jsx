import React from 'react';
import PropTypes from 'prop-types';

/**
 * ExternalLink
 *
 * Centralized component for rendering external links that open in a new tab.
 * Always applies `target="_blank"` with `rel="noopener noreferrer"` to prevent
 * the opened page from controlling the originating window (see issue #24).
 *
 * Requires descriptive link text via `children` or `label`. Appends a visually
 * hidden "(opens in new tab)" hint for screen reader users.
 */
function ExternalLink({ href, children, label, className, ...rest }) {
  const linkText = children || label;

  if (!href) {
    // eslint-disable-next-line no-console
    console.warn('ExternalLink: missing required `href` prop.');
  }

  if (!linkText) {
    // eslint-disable-next-line no-console
    console.warn(
      'ExternalLink: descriptive link text is required via `children` or `label`.'
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      {...rest}
    >
      {linkText}
      <span className="visually-hidden"> (opens in new tab)</span>
    </a>
  );
}

ExternalLink.propTypes = {
  href: PropTypes.string.isRequired,
  children: PropTypes.node,
  label: PropTypes.string,
  className: PropTypes.string,
};

ExternalLink.defaultProps = {
  children: null,
  label: undefined,
  className: undefined,
};

export default ExternalLink;