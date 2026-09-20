import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { zhTW } from '@dongfan/shared';
import { App } from './App.js';
import './index.css';

// Set here rather than in index.html so every Chinese string stays in the
// copy file and the language check keeps a single whitelist (spec 13.1).
document.title = zhTW.app.name;

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
