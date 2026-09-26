import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './ui/fonts/fonts.css';
import './ui/theme.css';
import './ui/layout.css';
import './ui/glass.css';

// On macOS the window is transparent and the system blurs the desktop behind
// it; anywhere else the page paints its own backdrop for the glass.
const nativeGlass =
  '__TAURI_INTERNALS__' in window && navigator.platform.toLowerCase().includes('mac');
document.documentElement.dataset.glass = nativeGlass ? 'native' : 'painted';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
