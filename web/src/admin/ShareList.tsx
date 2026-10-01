import { useEffect, useState } from 'react';
import { adminDelete, adminGet, adminPost } from './adminApi';

export type ShareStatus = 'active' | 'expired' | 'revoked';

/** `GET /api/admin/shares` 里一条分享的形状（见 server/routes/admin.js 的 publicShare）。 */
export interface AdminShare {
  id: string;
  token: string;
  root: string;
  label: string;
  createdAt: number;
  createdBy: string;
  expiresAt: number | null;
  revoked: boolean;
  allowUserCreation: boolean;
  defaultRole: 'viewer' | 'editor';
  maxUsers: number | null;
  userCount: number;
  online: number;
}

/**
 * 与服务端 `server/lib/shares.js` 的 `shareStatus` 同一套判定：
 * **撤销压过过期**。两个条件同时成立时（分享已经过期又被撤销）结果必须是
 * revoked——判定式的先后顺序本身就是行为的一部分，只测单一条件的用例
 * 抓不住"顺序被对调"这种错误，见 shares.test.js 的同名用例。
 */
export function shareStatusOf(
  share: Pick<AdminShare, 'revoked' | 'expiresAt'>,
  now: number,
): ShareStatus {
  if (share.revoked) return 'revoked';
  if (share.expiresAt !== null && now >= share.expiresAt) return 'expired';
  return 'active';
}

const STATUS_LABEL: Record<ShareStatus, string> = {
  active: '进行中',
  expired: '已过期',
  revoked: '已撤销',
};

/** 有效期预设（规格 §7.3）：24 小时 / 7 天 / 30 天 / 永不。 */
const EXPIRY_PRESETS: { label: string; hours: number | null }[] = [
  { label: '24 小时', hours: 24 },
  { label: '7 天', hours: 24 * 7 },
  { label: '30 天', hours: 24 * 30 },
  { label: '永不过期', hours: null },
];

interface NewShareForm {
  root: string;
  label: string;
  presetIndex: number;
  defaultRole: 'viewer' | 'editor';
  allowUserCreation: boolean;
  maxUsers: string; // 空串 = 不限（null）
}

const EMPTY_FORM: NewShareForm = {
  root: '', label: '', presetIndex: 1, defaultRole: 'editor', allowUserCreation: true, maxUsers: '',
};

interface ShareListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 供测试注入固定的"此刻"，避免过期判定在真实时钟下变成 flaky。 */
  now?: number;
}

export function ShareList({ selectedId, onSelect, now = Date.now() }: ShareListProps) {
  const [shares, setShares] = useState<AdminShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<NewShareForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<AdminShare | null>(null);
  const [revoking, setRevoking] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminGet<{ shares: AdminShare[] }>('/api/admin/shares');
      setShares(res.shares);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const submitCreate = async () => {
    setFormError(null);
    const root = form.root.trim();
    if (!root) { setFormError('请填写要分享的文件夹路径'); return; }

    const maxUsersRaw = form.maxUsers.trim();
    const maxUsers = maxUsersRaw === '' ? null : Number(maxUsersRaw);
    if (maxUsers !== null && (!Number.isInteger(maxUsers) || maxUsers < 1)) {
      setFormError('人数上限必须是不小于 1 的整数');
      return;
    }

    const preset = EXPIRY_PRESETS[form.presetIndex];
    setSubmitting(true);
    try {
      await adminPost('/api/admin/shares', {
        root,
        label: form.label.trim(),
        expiresAt: preset.hours === null ? null : now + preset.hours * 3600_000,
        defaultRole: form.defaultRole,
        allowUserCreation: form.allowUserCreation,
        maxUsers,
      });
      setForm(EMPTY_FORM);
      setFormOpen(false);
      await refresh();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await adminDelete(`/api/admin/shares/${revokeTarget.id}`);
      setRevokeTarget(null);
      await refresh();
    } catch (e) {
      // 撤销失败保留对话框，让管理员看得到原因、可以重试，而不是静默关掉
      // 却什么也没发生。
      setError((e as Error).message);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="admin-panel admin-shares">
      <div className="admin-panel-head">
        <h2>分享</h2>
        <button
          className="ghost"
          onClick={() => { setFormOpen((v) => !v); setFormError(null); }}
        >
          {formOpen ? '取消新建' : '+ 新建分享'}
        </button>
      </div>

      {formOpen && (
        <div className="admin-new-share">
          <label className="row">
            文件夹路径
            <input
              value={form.root}
              onChange={(e) => setForm((f) => ({ ...f, root: e.target.value }))}
              placeholder="/Users/.../2026-07-26 婚礼"
            />
          </label>
          <label className="row">
            标签
            <input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
          </label>
          <label className="row">
            有效期
            <select
              value={form.presetIndex}
              onChange={(e) => setForm((f) => ({ ...f, presetIndex: Number(e.target.value) }))}
            >
              {EXPIRY_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
            </select>
          </label>
          <label className="row">
            默认角色
            <select
              value={form.defaultRole}
              onChange={(e) => setForm((f) => ({ ...f, defaultRole: e.target.value as 'viewer' | 'editor' }))}
            >
              <option value="editor">可标记（editor）</option>
              <option value="viewer">只读（viewer）</option>
            </select>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={form.allowUserCreation}
              onChange={(e) => setForm((f) => ({ ...f, allowUserCreation: e.target.checked }))}
            />
            允许新成员加入
          </label>
          <label className="row">
            人数上限
            <input
              value={form.maxUsers}
              inputMode="numeric"
              placeholder="不限"
              onChange={(e) => setForm((f) => ({ ...f, maxUsers: e.target.value }))}
            />
          </label>
          {formError && <p className="error">{formError}</p>}
          <div className="modal-actions">
            <button className="primary" disabled={submitting} onClick={() => void submitCreate()}>
              创建
            </button>
          </div>
        </div>
      )}

      {loading && <p className="muted">加载中…</p>}
      {error && <p className="error">{error}</p>}

      <ul className="admin-share-list">
        {shares.map((share) => {
          const status = shareStatusOf(share, now);
          return (
            <li
              key={share.id}
              className={`admin-share-row${share.id === selectedId ? ' admin-row-selected' : ''}`}
            >
              <button className="admin-share-select ghost" onClick={() => onSelect(share.id)}>
                <strong>{share.label || '（未命名）'}</strong>
                <span className={`admin-status admin-status-${status}`}>{STATUS_LABEL[status]}</span>
                <span className="muted">{share.userCount} 人 · 在线 {share.online}</span>
              </button>
              <button
                className="ghost danger"
                disabled={share.revoked}
                onClick={() => setRevokeTarget(share)}
              >
                撤销
              </button>
            </li>
          );
        })}
        {!loading && shares.length === 0 && <li className="muted">还没有任何分享</li>}
      </ul>

      {/* 撤销前的二次确认：令牌就是密码，撤销即刻断开在线访客且不可恢复
          （updateShare 的 patch 白名单里没有 revoked，没有反悔的接口）。 */}
      {revokeTarget && (
        <div
          className="modal confirm-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setRevokeTarget(null); }}
        >
          <div className="modal-box" role="dialog" aria-label="确认撤销分享">
            <h2>撤销「{revokeTarget.label || '（未命名）'}」？</h2>
            <p>撤销会立即生效：这条链接的在线访客会被马上断开连接，且撤销后无法恢复。</p>
            <div className="modal-actions">
              <button onClick={() => setRevokeTarget(null)}>取消</button>
              <button className="primary danger" disabled={revoking} onClick={() => void confirmRevoke()}>
                确认撤销
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
