import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from './routes';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initializeTheme } from './store/theme';
import './styles.css';

const stopThemeSync = initializeTheme();
if (import.meta.hot) import.meta.hot.dispose(stopThemeSync);

if ('__TAURI_INTERNALS__' in window) {
  document.documentElement.classList.add('tauri');
}

// 三条入口只读一次 location.pathname 就够了（规格 §7.1：不引入路由库，
// 无嵌套、无参数解析）。真正的判定逻辑在 routes.tsx 里，可以脱离 DOM 单测；
// 这里是唯一一处读 window.location 的地方。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Router pathname={window.location.pathname} />
    </ErrorBoundary>
  </StrictMode>,
);
