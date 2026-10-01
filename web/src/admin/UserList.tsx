import { useEffect, useState } from 'react';
import { adminDelete, adminGet, adminPatch } from './adminApi';

export type Role = 'viewer' | 'editor';

/**
 * `GET /api/admin/shares/:id/users` 里一条用户记录的形状
 * （见 server/routes/admin.js 的 publicUser）。
 *
 * **故意没有 `token` 字段**——服务端逐字段挑出来下发，用户令牌永不出现在
 * 这个响应里。这个类型定义本身就是"界面上不显示用户令牌"这条要求的
 * 第一道防线：多出一个 token 字段来，TypeScript 都不会让你把它塞进这里。
 */
export interface AdminUser {
  id: string;
  shareId: string;
  nickname: string;
  role: Role;
  createdAt: number;
  lastSeenAt: number;
  disabled: boolean;
}

interface UserListProps {
  shareId: string | null;
}

export function UserList({ shareId }: UserListProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);

  const refresh = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminGet<{ users: AdminUser[] }>(`/api/admin/shares/${id}/users`);
      setUsers(res.users);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!shareId) { setUsers([]); return; }
    void refresh(shareId);
  }, [shareId]);

  /**
   * 角色切换 / 禁用启用共用的写入路径：**先乐观更新本地这一行，再发 PATCH**。
   * 失败时把这一行整体换回请求发出前的快照——不是根据错误消息猜哪个字段
   * 该回滚，用整份快照最不容易漏。
   */
  const patchUser = async (userId: string, patch: Partial<Pick<AdminUser, 'role' | 'disabled'>>) => {
    if (!shareId) return;
    const before = users;
    setUsers((list) => list.map((u) => (u.id === userId ? { ...u, ...patch } : u)));
    setBusyId(userId);
    try {
      await adminPatch(`/api/admin/shares/${shareId}/users/${userId}`, patch);
    } catch (e) {
      setUsers(before);
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!shareId || !deleteTarget) return;
    const id = deleteTarget.id;
    setBusyId(id);
    try {
      await adminDelete(`/api/admin/shares/${shareId}/users/${id}`);
      setUsers((list) => list.filter((u) => u.id !== id));
      setDeleteTarget(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (!shareId) {
    return (
      <div className="admin-panel admin-users">
        <h2>成员</h2>
        <p className="muted">先在左侧选一条分享</p>
      </div>
    );
  }

  return (
    <div className="admin-panel admin-users">
      <h2>成员</h2>
      {loading && <p className="muted">加载中…</p>}
      {error && <p className="error">{error}</p>}

      <table className="admin-user-table">
        <thead>
          <tr><th>昵称</th><th>角色</th><th>状态</th><th>最后活跃</th><th /></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.nickname}</td>
              <td>
                <select
                  value={u.role}
                  disabled={busyId === u.id}
                  onChange={(e) => void patchUser(u.id, { role: e.target.value as Role })}
                >
                  <option value="editor">可标记</option>
                  <option value="viewer">只读</option>
                </select>
              </td>
              <td>
                {/* 禁用/启用是一键切换，不需要二次确认——不可撤销的只有删除。 */}
                <button
                  className="ghost"
                  disabled={busyId === u.id}
                  onClick={() => void patchUser(u.id, { disabled: !u.disabled })}
                >
                  {u.disabled ? '已禁用（点击启用）' : '正常（点击禁用）'}
                </button>
              </td>
              <td className="muted">{new Date(u.lastSeenAt).toLocaleString()}</td>
              <td>
                <button className="ghost danger" onClick={() => setDeleteTarget(u)}>删除</button>
              </td>
            </tr>
          ))}
          {users.length === 0 && !loading && (
            <tr><td colSpan={5} className="muted">这条分享还没有人加入</td></tr>
          )}
        </tbody>
      </table>

      {/* 删除前的二次确认：令牌立即失效，且没有撤销这个动作的接口
          （users.js 没有"复活"一个被删除用户的方法）。 */}
      {deleteTarget && (
        <div
          className="modal confirm-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleteTarget(null); }}
        >
          <div className="modal-box" role="dialog" aria-label="确认删除用户">
            <h2>删除「{deleteTarget.nickname}」？</h2>
            <p>删除后这个人的令牌立即失效，他手上的链接从此打不开——这个操作不可撤销。</p>
            <div className="modal-actions">
              <button onClick={() => setDeleteTarget(null)}>取消</button>
              <button
                className="primary danger"
                disabled={busyId === deleteTarget.id}
                onClick={() => void confirmDelete()}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
