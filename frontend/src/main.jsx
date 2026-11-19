import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import App from './App';
import { ToastProvider } from './hooks/useToast';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

const THEME_STORAGE_KEY = 'theme';

function getStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      return stored;
    }
  } catch (error) {
    // Storage may be unavailable (e.g. privacy mode); fall back to OS preference.
  }
  return null;
}

function getSystemTheme() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch (error) {
    // matchMedia may be unavailable; default to light.
  }
  return 'light';
}

function applyInitialTheme() {
  const theme = getStoredTheme() || getSystemTheme();
  try {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
  } catch (error) {
    // Ignore failures applying theme; rendering should continue regardless.
  }
}

applyInitialTheme();

async function enableMocking() {
  if (import.meta.env.DEV) {
    const { worker } = await import('./mocks/browser');
    return worker.start();
  }
}

enableMocking().then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <BrowserRouter>
        <ErrorBoundary>
          <ToastProvider>
            <App />
          </ToastProvider>
        </ErrorBoundary>
      </BrowserRouter>
    </React.StrictMode>
  );
});