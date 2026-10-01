import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  // 抛出的值本身可以是任何类型（React 不要求 throw 一个 Error），
  // 所以这里存 unknown，不能存 Error | null —— 见下面 hasError 存在的原因。
  error: unknown;
}

/** 把 throw 出来的任意值变成一段可读文字，绝不能自己再抛一次。 */
function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message || '(空消息)';
  }
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) {
    return `未知错误（组件抛出的值是 ${String(error)}，不是 Error 实例）`;
  }
  try {
    return `未知错误（非 Error 值）：${JSON.stringify(error)}`;
  } catch {
    // 值本身不可序列化（循环引用等）——退到 String()，它对任何值都不会抛。
    return `未知错误（非 Error 值，无法序列化）：${String(error)}`;
  }
}

/**
 * 安全网，不是恢复框架。任何组件渲染时抛错，React 默认会把整棵树卸载成
 * 空白页——选片过程中标记可能还在 500ms 防抖里等着落盘，一崩就白屏，
 * 摄影师连"这次到底存上了没"都无从确认。这里只做兜底展示 + 手动刷新，
 * 不吞错误、不尝试自己恢复某个组件的状态（那是各组件自己的责任，例如
 * Toast.tsx 已经修过的、撤销栈为空时读 .length 崩掉的那次）。
 *
 * 状态用 hasError 单独标记，而不是靠 error 是否为 null/falsy 来判断——
 * 如果某个组件 throw null 或 throw undefined（合法但少见），getDerivedStateFromError
 * 会原样存下这个值，此时 error 本身是 falsy，如果 render() 只判断
 * `if (!error) return children`，就会把刚刚崩溃的子树重新挂载回去，
 * 陷入"抛出 → 复原 → 再抛出"的死循环，兜底画面和刷新按钮反而永远不出现，
 * 比放任白屏还糟。hasError 一旦为 true 就不会再变回 false（没有恢复路径，
 * 唯一出路是用户手动刷新整个页面），所以不存在这个歧义。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary 捕获到渲染错误：', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', padding: 24, textAlign: 'center', gap: 12, fontFamily: 'sans-serif',
      }}>
        <p style={{ fontSize: 16 }}>页面出了点问题，已经崩溃。</p>
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          标记如果几秒前刚改过，可能还没来得及存盘；刷新前请留意。
        </p>
        <pre style={{
          maxWidth: '80vw', maxHeight: '30vh', overflow: 'auto', textAlign: 'left',
          fontSize: 12, background: 'rgba(127,127,127,0.15)', padding: 12, borderRadius: 6,
        }}>
          {describeThrown(this.state.error)}
        </pre>
        <button onClick={() => window.location.reload()}>刷新页面</button>
      </div>
    );
  }
}
