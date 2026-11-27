import { useEffect } from 'react';

const DEFAULT_TITLE = 'Dashboard';

/**
 * Sets the document title for the lifetime of the component.
 * Restores the previous title when the component unmounts or when the
 * title changes, so each route can set a unique title and the default
 * title is restored when leaving the route.
 *
 * @param {string} title - The title to apply to the document.
 */
export function useDocumentTitle(title) {
  useEffect(() => {
    const previousTitle = document.title;

    if (title) {
      document.title = title;
    }

    return () => {
      document.title = previousTitle || DEFAULT_TITLE;
    };
  }, [title]);
}

export { DEFAULT_TITLE };
export default useDocumentTitle;