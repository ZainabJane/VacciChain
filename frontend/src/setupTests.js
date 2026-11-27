import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';

// Configure jsdom focus behavior for accessible dialog tests.
// jsdom does not fully implement focus management, so we ensure
// elements can be focused and that focus events propagate correctly.
if (typeof window !== 'undefined') {
  // Ensure HTMLElement.prototype.focus is available and functional.
  if (!HTMLElement.prototype.focus) {
    HTMLElement.prototype.focus = function focus() {
      // no-op fallback
    };
  }

  // jsdom does not implement scrollIntoView, which some focus libraries call.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {
      // no-op
    };
  }

  // jsdom does not implement the inert property; provide a minimal shim
  // so focus-trap libraries that check it do not throw.
  if (!('inert' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'inert', {
      configurable: true,
      get() {
        return this.hasAttribute('inert');
      },
      set(value) {
        if (value) {
          this.setAttribute('inert', '');
        } else {
          this.removeAttribute('inert');
        }
      },
    });
  }
}

// Expose a shared user-event instance factory for keyboard interaction tests.
export const setupUserEvent = () =>
  userEvent.setup({
    // Use fake timers-friendly advanceTimers if tests opt in.
    advanceTimers: (delay) => {
      if (typeof jest !== 'undefined') {
        jest.advanceTimersByTime(delay);
      }
    },
  });
