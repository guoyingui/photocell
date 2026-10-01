import { create } from 'zustand';

type Theme = 'light' | 'dark';
const KEY = 'photocull.theme';

function readPreference(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light' : 'dark';
}

function applyTheme(theme: Theme) {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
}

interface ThemeState {
  theme: Theme;
  preference: Theme | null;
  setTheme: (theme: Theme) => void;
}

const preference = readPreference();

export const useTheme = create<ThemeState>((set) => ({
  theme: preference ?? systemTheme(),
  preference,
  setTheme(theme) {
    // 隐私模式下存储可能不可用，仍然允许切换当前界面。
    try { localStorage.setItem(KEY, theme); } catch { /* 本次会话内生效 */ }
    applyTheme(theme);
    set({ theme, preference: theme });
  },
}));

/** 页面启动时应用主题；用户尚未手动选择时继续跟随系统。 */
export function initializeTheme(): () => void {
  const preference = readPreference();
  const theme = preference ?? systemTheme();
  useTheme.setState({ preference, theme });
  applyTheme(theme);

  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  const onChange = () => {
    if (useTheme.getState().preference !== null) return;
    const theme = systemTheme();
    useTheme.setState({ theme });
    applyTheme(theme);
  };
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
}
