import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startBoard } from './board/start';
import { ErrorBoundary } from './components/ErrorBoundary';
import { VIEWS, ui, uiStore, type View } from './lib/ui';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/cards.css';
import './styles/views.css';
import './styles/detail.css';
import './styles/office.css';

/** Bare-token deep links (the only kind an artifact link carries): #signoffs, #underway, #office, #orders, #log, #chat, #crew, #settings; #deck and #muster, the screens' display names, map to their view ids. */
const OLD: Record<string, View> = { deck: 'office', muster: 'crew' };
function showHash() {
  const hash = location.hash.replace(/^#/, '');
  if ((VIEWS as string[]).includes(hash)) ui.setView(hash as View);
  else if (OLD[hash]) ui.setView(OLD[hash]);
}
showHash();
window.addEventListener('hashchange', showHash);

ui.setTheme(uiStore.get().theme);

void startBoard();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
