import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { recordUncaughtErrors } from './shared/diagnostics';
import { App } from './shell/App';
import { Providers } from './shell/Providers';

recordUncaughtErrors();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
