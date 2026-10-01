import { useTheme } from '../store/theme';

export function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'light' ? '白色主题' : '黑色主题';

  return (
    <button type="button" className="theme-toggle" aria-label={`切换到${label}`}
            title={`切换到${label}`} onClick={() => setTheme(next)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {next === 'light' ? <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </> : <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />}
      </svg>
      {label}
    </button>
  );
}
