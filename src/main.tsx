import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './hooks/useTheme.tsx';
import { I18nProvider } from './i18n/index.tsx';
import App from './App.tsx';
import { completePendingLocalDataReset } from './services/localData.ts';
import './index.css';

// Installable PWA: register the app-shell service worker in production builds only,
// so the dev server never serves stale cached assets during development.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

function renderApp() {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('index.html is missing the #root element');
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <I18nProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </I18nProvider>
      </ThemeProvider>
    </React.StrictMode>,
  );
}

// A requested local-data reset must run before anything opens a document
// database — a live y-indexeddb connection would block the deletion.
completePendingLocalDataReset()
  .catch((error) => console.error('local data: pending reset failed', error))
  .finally(renderApp);
