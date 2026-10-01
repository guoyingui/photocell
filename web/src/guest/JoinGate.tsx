import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { getJSON, postJSON, setSessionId } from '../lib/api';
import type { ApiError } from '../lib/api';
import { setSession } from '../store/session';
import type { Role } from '../store/session';
import { Blocker } from '../components/Blocker';
import { GuestApp } from './GuestApp';

/** GET /api/share/:token/info 的响应形状（规格 §5.1）。 */
interface ShareInfo {
  label: string;
  /** 会话没开着时服务端答不出真实数量，只能是 null——界面必须接受这个值，
   *  而不是假设它总是一个数字。 */
  assetCountHint: number | null;
  allowUserCreation: boolean;
  requiresNickname: boolean;
  expiresAt: number | null;
}

/**
 * join / resume 成功后的响应形状（规格 §5.2）。
 * 故意没有 `root` 字段——服务端刻意不返回它，这里也不去猜它可能存在。
 */
interface JoinResult {
  sessionId: string;
  user: { id: string; nickname: string; role: Role };
  share: { label: string };
  assetCount: number;
  warnings: unknown[];
  skippedFiles: unknown[];
  settings: unknown;
  marksRecovered: boolean;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'blocked'; message: string }
  | { kind: 'form' }
  // 整份 join 结果留在 phase 里：GuestApp 需要 marksRecovered，而那个字段
  // **只有** join/resume 的响应给得出来——`GET /api/library/marks` 不返回它。
  | { kind: 'joined'; result: JoinResult };

/** 服务端的结构化错误都走 lib/api.ts 的 ApiError，`message` 已经是给人看的文案。
 *  网络层直接失败之类的极端情况没有 message，退回一句通用提示。 */
function messageOf(err: unknown): string {
  const m = (err as ApiError | undefined)?.message;
  return typeof m === 'string' && m.length > 0 ? m : '出错了，请稍后再试';
}

function statusOf(err: unknown): number | undefined {
  return (err as ApiError | undefined)?.status;
}

/**
 * 访客接入界面。覆盖规格 §5 与 §10 描述的全部路径：
 *   - 链接无效（过期/撤销/不存在，三者响应逐字节一致）-> 整页阻断，不出现表单；
 *   - 带着仍然有效的 Cookie 回访 -> 免昵称直接进入；
 *   - 首次访问 -> 昵称表单；提交失败（占用/关闭新成员/满员/限流）内联报错，
 *     且保留用户已经输入的昵称——把他刚想好的名字清空是没有必要的伤害；
 *   - 提交中禁用按钮，避免用户手滑连点两下建出两个账号。
 *
 * 加入成功之后渲染什么由 `children` 决定：这个组件只负责"把人放进来"，
 * 不关心放进来之后看到的是什么——那是 Task 16 的 GuestApp 接上时的事。
 * 没有传 children 时给一个最小的成功占位，保证组件独立可用、可测。
 */
export function JoinGate({ token, children }: { token: string; children?: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [nickname, setNickname] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function applyJoined(result: JoinResult) {
    setSessionId(result.sessionId);
    setSession({ kind: 'user', user: result.user, share: result.share });
    setPhase({ kind: 'joined', result });
  }

  useEffect(() => {
    let cancelled = false;
    // 重置成"检查中"：token 变化（理论上不会在这个组件生命周期内发生，
    // 但测试会用不同 token 重新挂载）不该带着上一个 token 的表单状态。
    setPhase({ kind: 'loading' });
    setInfo(null);
    setFormError(null);

    (async () => {
      let data: ShareInfo;
      try {
        data = await getJSON<ShareInfo>(`/api/share/${token}/info`);
      } catch (err) {
        if (!cancelled) setPhase({ kind: 'blocked', message: messageOf(err) });
        return;
      }
      if (cancelled) return;
      setInfo(data);

      // 凭 Cookie 尝试免昵称回访。绝大多数第一次点开链接的人没有这枚 Cookie，
      // 这次调用以 401 need-join 收场是正常路径，不是错误——落到昵称表单。
      // 只有 404（链接在这两次请求之间失效，一个罕见的竞态窗口）才升级成
      // 整页阻断，否则会给用户弹出一个马上又会被拒的表单。
      try {
        const resumed = await postJSON<JoinResult>(`/api/share/${token}/resume`);
        if (!cancelled) applyJoined(resumed);
      } catch (err) {
        if (cancelled) return;
        if (statusOf(err) === 404) {
          setPhase({ kind: 'blocked', message: messageOf(err) });
        } else {
          setPhase({ kind: 'form' });
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只依赖 token 本身。
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await postJSON<JoinResult>(`/api/share/${token}/join`, { nickname });
      applyJoined(result);
    } catch (err) {
      // 昵称输入框不清空：用户刚打出的名字如果因为撞名/限流之类的原因被拒绝，
      // 把输入框清空等于逼他重新想一遍、重新打一遍。
      setFormError(messageOf(err));
      setSubmitting(false);
    }
  }

  if (phase.kind === 'loading') {
    return <div className="join-gate join-gate-loading">正在检查链接…</div>;
  }

  if (phase.kind === 'blocked') {
    return <Blocker title="无法访问" message={phase.message} detail="请向摄影师索要新链接。" />;
  }

  if (phase.kind === 'joined') {
    // 默认就是访客选片界面本体。`children` 保留为替换点：它让 JoinGate 自己
    // 的用例可以在不拖起整棵选片树（Grid + 虚拟列表 + 缩略图）的前提下断言
    // 「人已经被放进来了」。
    return children != null
      ? <>{children}</>
      : <GuestApp marksRecovered={phase.result.marksRecovered} />;
  }

  return (
    <div className="join-gate join-gate-form">
      <h1>{info?.label ?? '加入选片'}</h1>
      {info?.assetCountHint != null && <p className="muted">约 {info.assetCountHint} 张照片</p>}
      <form onSubmit={handleSubmit}>
        <label className="row">
          昵称
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            disabled={submitting}
            placeholder="给自己起个名字"
            autoFocus
          />
        </label>
        {formError && <p className="error" role="alert">{formError}</p>}
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? '加入中…' : '加入选片'}
        </button>
      </form>
    </div>
  );
}
