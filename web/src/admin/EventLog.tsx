import { useEffect, useState } from 'react';
import { adminGet } from './adminApi';

/**
 * 审计日志一行的形状。除了 ts/actor/nickname/action 这几个固定列，
 * 其余字段是动作专属的载荷（assetId、from/to、reason……），
 * 与服务端 `eventsToCsv` 的 CSV 布局（ts,actor,nickname,action,payload）对应。
 */
export interface AuditEvent {
  ts: number;
  actor: string;
  nickname?: string;
  action: string;
  [key: string]: unknown;
}

/** 规格 §3.4 的动作全集，供过滤下拉框使用。与 server/lib/audit.js 的 ACTIONS 逐字对齐。 */
const ACTIONS = [
  'share.create', 'share.update', 'share.revoke',
  'user.join', 'user.resume', 'user.denied',
  'user.role-change', 'user.disable', 'user.enable', 'user.delete',
  'session.connect', 'session.disconnect',
  'mark.set', 'mark.bulk',
  'settings.update', 'export.run',
  'selection.submit', 'selection.confirm', 'selection.reopen', 'selection.final',
  'annotations.update', 'export.xmp',
];

/** CSV/表格「详情」列要排除的固定列，与 server/lib/audit.js 的 eventsToCsv 保持一致。 */
const KNOWN_KEYS = new Set(['ts', 'shareId', 'actor', 'nickname', 'action']);

function payloadOf(ev: AuditEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (!KNOWN_KEYS.has(k)) out[k] = v;
  }
  return out;
}

const PAGE_SIZE = 50;

function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

interface EventLogProps {
  shareId: string | null;
}

export function EventLog({ shareId }: EventLogProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actorFilter, setActorFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  const loadPage = async (id: string, offset: number, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const query = buildQuery({
        limit: PAGE_SIZE,
        offset,
        actor: actorFilter.trim() || undefined,
        action: actionFilter || undefined,
      });
      const res = await adminGet<{ events: AuditEvent[]; total: number }>(
        `/api/admin/shares/${id}/events${query}`,
      );
      setTotal(res.total);
      setEvents((prev) => (replace ? res.events : [...prev, ...res.events]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // shareId、actorFilter、actionFilter 任何一个变了都要**从第 0 页整表重取**，
  // 而不是在已经加载的旧结果上客户端再筛一遍——否则"已加载条数"和服务端
  // 权威的 total 会对不上，过滤条件叠加时尤其容易读错。
  useEffect(() => {
    if (!shareId) { setEvents([]); setTotal(0); return; }
    void loadPage(shareId, 0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId, actorFilter, actionFilter]);

  const loadMore = () => {
    if (shareId) void loadPage(shareId, events.length, false);
  };

  const csvHref = shareId
    ? `/api/admin/shares/${shareId}/events.csv${buildQuery({
      actor: actorFilter.trim() || undefined,
      action: actionFilter || undefined,
    })}`
    : null;

  if (!shareId) {
    return (
      <div className="admin-panel admin-events">
        <h2>操作日志</h2>
        <p className="muted">先在左侧选一条分享</p>
      </div>
    );
  }

  return (
    <div className="admin-panel admin-events">
      <div className="admin-panel-head">
        <h2>操作日志</h2>
        {csvHref && (
          <a className="ghost" href={csvHref} download={`photocull-events-${shareId}.csv`}>导出 CSV</a>
        )}
      </div>

      <div className="admin-event-filters">
        <label className="row">
          操作者
          <input
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            placeholder="admin 或用户 id"
          />
        </label>
        <label className="row">
          动作
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
            <option value="">全部</option>
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      </div>

      {/* 审计日志的 actor 语义有个坑：user.role-change / disable / enable / delete
          这几条的 actor 恒为 'admin'，被操作的人记在 nickname 列和载荷的
          targetUserId 里——按 actor 筛选找不到"管理员对某人做的操作"，
          必须把这一点写在界面上，否则管理员会误以为这个人从没被改过角色。 */}
      <p className="muted admin-event-hint">
        提示：管理员对某个成员的操作（改角色 / 禁用 / 启用 / 删除）记为
        操作者 = admin，被操作的人显示在"昵称"列——按"操作者"筛选找不到
        这类记录，想确认某人是否被改过，请看昵称列，或不加筛选浏览全部。
      </p>

      {error && <p className="error">{error}</p>}

      <table className="admin-event-table">
        <thead>
          <tr><th>时间</th><th>操作者</th><th>昵称</th><th>动作</th><th>详情</th></tr>
        </thead>
        <tbody>
          {events.map((ev, i) => (
            <tr key={`${ev.ts}-${ev.actor}-${i}`}>
              <td className="muted">{new Date(ev.ts).toLocaleString()}</td>
              <td>{ev.actor}</td>
              <td>{ev.nickname ?? ''}</td>
              <td>{ev.action}</td>
              <td className="admin-event-payload"><code>{JSON.stringify(payloadOf(ev))}</code></td>
            </tr>
          ))}
          {events.length === 0 && !loading && (
            <tr><td colSpan={5} className="muted">没有符合条件的记录</td></tr>
          )}
        </tbody>
      </table>

      {loading && <p className="muted">加载中…</p>}

      {events.length < total && (
        <div className="modal-actions">
          <button onClick={loadMore} disabled={loading}>加载更多（{events.length} / {total}）</button>
        </div>
      )}
    </div>
  );
}
