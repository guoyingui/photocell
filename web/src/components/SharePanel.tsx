import { useEffect, useState } from 'react';
import { getJSON, postJSON, patchJSON, deleteJSON } from '../lib/api';

/**
 * 本地界面的分享管理面板（规格 §7.3，计划 Task 18）。
 *
 * 三条硬要求，任何便利性设计都要让路：
 *
 * 1. **风险提示必须显著**：这条链接本身就是密码，拿到的人都能进——
 *    没有第二道验证。有效期 / 撤销 / 人数上限 / 关闭新成员是四个闸门，
 *    必须是这个面板里真的能点、能改的控件，不是文档里提一句就算数。
 * 2. **没开 `--share` 时绝不拼一条连不上的链接。** `GET /api/admin/netaddr`
 *    的 `share` 字段就是唯一的事实来源：为 false 时只显示"需要用这条命令
 *    重启"，命令本身原样给出，不显示任何地址选择器或 http:// 链接——
 *    哪怕 `addresses` 不为空（服务端不管有没有分享都会探测网卡）。
 * 3. **多网卡时列出全部候选地址，不自动挑一个。** 服务端已经把回环地址和
 *    IPv6 链路本地地址过滤掉了（`server/lib/netaddr.js`），这里拿到的每一条
 *    都是"原则上能用"的，具体哪个网段客人连得上只有摄影师自己知道——
 *    前端不能替他再筛一轮，也不能预选中第一个。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 数据形状
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'viewer' | 'editor';

export interface ShareRecord {
  id: string;
  token: string;
  root: string;
  label: string;
  createdAt: number;
  createdBy?: string;
  expiresAt: number | null;
  revoked: boolean;
  allowUserCreation: boolean;
  defaultRole: Role;
  maxUsers: number | null;
  /** 这条分享的客户彼此看不看得见对方的选片标记。摄影师自己不受影响。 */
  showPeerMarks: boolean;
  userCount: number;
  online: number;
}

interface NetAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
  interface: string;
}

interface NetInfo {
  share: boolean;
  port: number | null;
  addresses: NetAddress[];
}

export type ExpiryPreset = '24h' | '7d' | '30d' | 'never';

const PRESET_MS: Record<Exclude<ExpiryPreset, 'never'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * 有效期预设 -> `expiresAt` 毫秒时间戳（或 `null` = 永不过期）。
 * 纯函数，`now` 可注入——不这样的话"24 小时"这条换算只能靠 sleep 或者
 * 掐着表跑，边界值永远测不到。
 */
export function expiresAtForPreset(preset: ExpiryPreset, now: number = Date.now()): number | null {
  if (preset === 'never') return null;
  return now + PRESET_MS[preset];
}

// ─────────────────────────────────────────────────────────────────────────────
// 派生的小工具（都是纯函数，方便单独验证）
// ─────────────────────────────────────────────────────────────────────────────

type ShareStatus = 'active' | 'expired' | 'revoked';

/** 与 server/lib/shares.js 的 shareStatus 同一套语义：撤销压过一切，过期边界是 `>=`。 */
function shareStatus(share: ShareRecord, now: number): ShareStatus {
  if (share.revoked) return 'revoked';
  if (share.expiresAt !== null && now >= share.expiresAt) return 'expired';
  return 'active';
}

const STATUS_LABEL: Record<ShareStatus, string> = {
  active: '进行中', expired: '已过期', revoked: '已撤销',
};

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return '永不过期';
  return new Date(expiresAt).toLocaleString();
}

/** 地址在同一个 `<input type="radio">` 组里的唯一 key。 */
function addrKey(a: NetAddress): string {
  return `${a.interface}|${a.family}|${a.address}`;
}

/** IPv6 地址在 URL 里必须套方括号，否则冒号会被解析成端口分隔符。 */
function buildLink(addr: NetAddress, port: number, token: string): string {
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return `http://${host}:${port}/s/${token}`;
}

interface AddressGroup {
  interface: string;
  ipv4: NetAddress[];
  ipv6: NetAddress[];
}

/**
 * 按网卡分组，组内再按 v4/v6 拆开——展示时 IPv4 直接列出，IPv6 折进
 * 一个默认收起的 `<details>`（多数是会轮换的临时地址，直接铺开只会
 * 让人更难挑）。**分组只是展示上的整理，一个地址都不会因此被丢弃**——
 * 全部地址原样进了这个结构，只是分了个类。
 */
function groupByInterface(addresses: NetAddress[]): AddressGroup[] {
  const order: string[] = [];
  const map = new Map<string, AddressGroup>();
  for (const a of addresses) {
    let g = map.get(a.interface);
    if (!g) {
      g = { interface: a.interface, ipv4: [], ipv6: [] };
      map.set(a.interface, g);
      order.push(a.interface);
    }
    (a.family === 'IPv4' ? g.ipv4 : g.ipv6).push(a);
  }
  return order.map((name) => map.get(name)!);
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// 组件
// ─────────────────────────────────────────────────────────────────────────────

export function SharePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [shares, setShares] = useState<ShareRecord[] | null>(null);
  const [net, setNet] = useState<NetInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [preset, setPreset] = useState<ExpiryPreset>('7d');
  const [defaultRole, setDefaultRole] = useState<Role>('editor');
  const [allowUserCreation, setAllowUserCreation] = useState(true);
  // 默认勾上 = 默认公开，和服务端 createShare 的默认值同一个口径。
  const [showPeerMarks, setShowPeerMarks] = useState(true);
  const [maxUsersText, setMaxUsersText] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const [sharesRes, netRes] = await Promise.all([
        getJSON<{ shares: ShareRecord[] }>('/api/admin/shares'),
        getJSON<NetInfo>('/api/admin/netaddr'),
      ]);
      setShares(sharesRes.shares);
      setNet(netRes);
      setLoadError(null);
    } catch (e) {
      setLoadError(describeError(e));
    }
  };

  // 每次打开面板都重新拉一遍——分享列表、在线人数、网络可用性都可能在
  // 面板关着的这段时间里变了。选中的网卡地址也不沿用上一次：换了个网络
  // 环境（比如带着笔记本从家里挪到片场）之后，上次选中的地址未必还在。
  useEffect(() => {
    if (!open) return;
    setSelectedAddr(null);
    setRevokeConfirmId(null);
    void load();
  }, [open]);

  if (!open) return null;

  const submitCreate = async () => {
    setCreateError(null);
    let maxUsers: number | null = null;
    const trimmed = maxUsersText.trim();
    if (trimmed !== '') {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1) {
        setCreateError('人数上限必须是不小于 1 的整数，留空表示不限');
        return;
      }
      maxUsers = n;
    }
    setCreating(true);
    try {
      await postJSON('/api/admin/shares', {
        label,
        expiresAt: expiresAtForPreset(preset),
        defaultRole,
        allowUserCreation,
        maxUsers,
        showPeerMarks,
      });
      setLabel('');
      setMaxUsersText('');
      await load();
    } catch (e) {
      setCreateError(describeError(e));
    } finally {
      setCreating(false);
    }
  };

  const toggleAllow = async (share: ShareRecord) => {
    setRowError(null);
    try {
      await patchJSON(`/api/admin/shares/${share.id}`, { allowUserCreation: !share.allowUserCreation });
      await load();
    } catch (e) {
      setRowError(describeError(e));
    }
  };

  const togglePeerMarks = async (share: ShareRecord) => {
    setRowError(null);
    try {
      await patchJSON(`/api/admin/shares/${share.id}`, { showPeerMarks: !share.showPeerMarks });
      await load();
    } catch (e) {
      setRowError(describeError(e));
    }
  };

  const confirmRevoke = async (share: ShareRecord) => {
    setRowError(null);
    try {
      await deleteJSON(`/api/admin/shares/${share.id}`);
      setRevokeConfirmId(null);
      await load();
    } catch (e) {
      setRowError(describeError(e));
    }
  };

  const copyLink = (url: string, id: string) => {
    // 剪贴板 API 在部分环境（非安全上下文、jsdom）里不存在或会拒绝——
    // 复制只是便利功能，失败不该弹错误打断摄影师。
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  };

  const groups = net ? groupByInterface(net.addresses) : [];
  const selected = net?.addresses.find((a) => addrKey(a) === selectedAddr) ?? null;
  const now = Date.now();

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box share-panel">
        <div className="share-head">
          <h2>分享</h2>
          <button type="button" className="share-close" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="share-body">

        {/* 要求 1：风险提示必须显著——放在面板最上面，不依赖任何数据加载完成。 */}
        <p className="share-risk">
          <strong>这个链接就是密码，拿到的人都能进。</strong>
          转发给谁，谁就能查看、并且（如果允许）标记这批照片——请像对待一份凭据一样对待它。
          有效期、随时撤销、人数上限、关闭新成员加入，是你能收回这份授权的四个开关。
        </p>

        {loadError && <p className="error">{loadError}</p>}

        {/* 要求 2：没开 --share 时不给一条连不上的链接，只给重启指引和命令本身。 */}
        {net && !net.share && (
          <div className="share-restart">
            <p><strong>尚未开启局域网分享。</strong>局域网内的其他人现在连不上这台电脑——
              发一条 <code>http://127.0.0.1</code> 开头的链接给客户，他只会打不开。</p>
            <p>要让别人一起选片，请先停掉当前这个进程，再用这条命令重新启动：</p>
            <code className="share-cmd">npm start -- --share</code>
          </div>
        )}

        {/* 要求 3：开了分享之后，列出全部候选地址，一个都不替人挑、也不预选。 */}
        {net?.share && (
          <div className="share-net">
            <h3>选择用来生成链接的网络地址</h3>
            {net.addresses.length === 0 && (
              <p className="warn">没有检测到可用的局域网地址（网线和 Wi-Fi 都没连上？）。</p>
            )}
            {groups.map((g) => (
              <div className="share-net-group" key={g.interface}>
                <div className="share-net-iface">{g.interface}</div>
                {g.ipv4.map((a) => (
                  <label className="share-net-addr" key={addrKey(a)}>
                    <input
                      type="radio"
                      name="share-net-addr"
                      checked={selectedAddr === addrKey(a)}
                      onChange={() => setSelectedAddr(addrKey(a))}
                    />
                    {a.address}
                  </label>
                ))}
                {g.ipv6.length > 0 && (
                  <details className="share-net-ipv6">
                    <summary>IPv6（{g.ipv6.length} 个，多数是会轮换的临时地址，默认折叠）</summary>
                    {g.ipv6.map((a) => (
                      <label className="share-net-addr" key={addrKey(a)}>
                        <input
                          type="radio"
                          name="share-net-addr"
                          checked={selectedAddr === addrKey(a)}
                          onChange={() => setSelectedAddr(addrKey(a))}
                        />
                        {a.address}
                      </label>
                    ))}
                  </details>
                )}
              </div>
            ))}
          </div>
        )}

        <hr />

        <h3>新建分享</h3>
        <label className="row">
          标签
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：小林的婚礼精选" />
        </label>
        <label className="row">
          有效期
          <select value={preset} onChange={(e) => setPreset(e.target.value as ExpiryPreset)}>
            <option value="24h">24 小时</option>
            <option value="7d">7 天</option>
            <option value="30d">30 天</option>
            <option value="never">永不过期</option>
          </select>
        </label>
        <label className="row">
          默认角色
          <select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value as Role)}>
            <option value="editor">可标记</option>
            <option value="viewer">只读</option>
          </select>
        </label>
        <label className="row">
          人数上限
          <input
            value={maxUsersText}
            onChange={(e) => setMaxUsersText(e.target.value)}
            placeholder="不限"
            inputMode="numeric"
          />
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={allowUserCreation}
            onChange={(e) => setAllowUserCreation(e.target.checked)}
          />
          允许新成员加入
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={showPeerMarks}
            onChange={(e) => setShowPeerMarks(e.target.checked)}
          />
          让客户看到彼此的选片标记
        </label>
        <p className="muted share-hint">
          关掉之后，每位客户只看得见<b>自己的</b>选择和<b>你的</b>选择，看不见别的客户选了什么。
          你自己在这边照常看得到全部，也能按人筛。
        </p>
        {createError && <p className="error">{createError}</p>}
        <div className="modal-actions">
          <button className="primary" onClick={() => void submitCreate()} disabled={creating}>
            新建分享
          </button>
        </div>

        <hr />

        <h3>已有的分享</h3>
        {rowError && <p className="error">{rowError}</p>}
        {shares === null && <p className="muted">加载中…</p>}
        {shares !== null && shares.length === 0 && <p className="muted">还没有分享过这个文件夹。</p>}
        {shares !== null && shares.map((share) => {
          const status = shareStatus(share, now);
          const link = net?.share && selected && net.port != null
            ? buildLink(selected, net.port, share.token) : null;
          return (
            <div className="share-row" key={share.id}>
              <div className="share-row-main">
                <strong>{share.label || '（未命名）'}</strong>
                <span className={`share-status share-status-${status}`}>{STATUS_LABEL[status]}</span>
                <span className="muted">在线 {share.online} · 共 {share.userCount} 人</span>
              </div>
              <div className="share-row-meta muted">
                有效期：{formatExpiry(share.expiresAt)}
              </div>
              <div className="share-row-actions">
                {link ? (
                  <>
                    <code className="share-link-text">{link}</code>
                    <button onClick={() => copyLink(link, share.id)}>
                      {copiedId === share.id ? '已复制' : '复制链接'}
                    </button>
                  </>
                ) : net?.share ? (
                  <span className="muted">请先在上方选择一个网络地址</span>
                ) : (
                  <span className="muted">开启 --share 后才能生成链接</span>
                )}
                <button onClick={() => void toggleAllow(share)} disabled={share.revoked}>
                  {share.allowUserCreation ? '关闭新成员' : '开启新成员'}
                </button>
                <button onClick={() => void togglePeerMarks(share)} disabled={share.revoked}>
                  {share.showPeerMarks ? '隐藏客户标记' : '公开客户标记'}
                </button>
                {revokeConfirmId === share.id ? (
                  <span className="share-revoke-confirm">
                    确定撤销？在线访客会立即被断开。
                    <button className="danger" onClick={() => void confirmRevoke(share)}>确定撤销</button>
                    <button onClick={() => setRevokeConfirmId(null)}>取消</button>
                  </span>
                ) : (
                  <button onClick={() => setRevokeConfirmId(share.id)} disabled={share.revoked}>撤销</button>
                )}
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
