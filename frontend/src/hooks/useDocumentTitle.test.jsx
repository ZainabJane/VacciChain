import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDocumentTitle } from './useDocumentTitle';

const DEFAULT_TITLE = 'Default Title';

function TestComponent({ title }) {
  useDocumentTitle(title);
  return <div>{title}</div>;
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = DEFAULT_TITLE;
  });

  afterEach(() => {
    cleanup();
    document.title = DEFAULT_TITLE;
  });

  it('sets the document title to the provided title', () => {
    render(<TestComponent title="Dashboard" />);
    expect(document.title).toBe('Dashboard');
  });

  it('updates the document title when the title prop changes', () => {
    const { rerender } = render(<TestComponent title="Dashboard" />);
    expect(document.title).toBe('Dashboard');

    rerender(<TestComponent title="Verification" />);
    expect(document.title).toBe('Verification');
  });

  it('restores the default title when unmounted', () => {
    const { unmount } = render(<TestComponent title="Dashboard" />);
    expect(document.title).toBe('Dashboard');

    unmount();
    expect(document.title).toBe(DEFAULT_TITLE);
  });

  it('restores the default title when the title becomes empty', () => {
    const { rerender } = render(<TestComponent title="Dashboard" />);
    expect(document.title).toBe('Dashboard');

    rerender(<TestComponent title="" />);
    expect(document.title).toBe(DEFAULT_TITLE);
  });

  it('sets unique titles for different routes', () => {
    const titles = ['Dashboard', 'Verification', 'Settings'];

    titles.forEach((title) => {
      render(<TestComponent title={title} />);
      expect(document.title).toBe(title);
      cleanup();
      expect(document.title).toBe(DEFAULT_TITLE);
    });

    expect(new Set(titles).size).toBe(titles.length);
  });
});