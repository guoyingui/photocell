import { create } from 'zustand';
import { getJSON } from './api';
import { useMarks } from '../store/marks';
import type { MarkBy } from '../store/marks';
import { actorId, setSession, useSession } from '../store/session';
import type { OnlineUser, Role } from '../store/session';
import type { BlockerProps } from '../components/Blocker';
import type { Mark } from '../types';

/**
 * SSE 协同事件的路由与合并（规格 §6.3，计划 Task 17）。
 *
 * 这个模块**只**认服务端广播出来的那六类协同事件——`marks` / `presence` /
 * `role` / `kicked` / `share-ended` / `hidden`。`meta` / `metaDone` / `bake` / `scan`
 * 是同一条流上另一码事（本机的解码与烘焙进度），归各自的调用方处理；
 * `handleRealtimeEvent` 用返回值把这条界线画出来，而不是靠两边各记一份
 * 类型清单去对齐。
 *
 * 本地界面（`store/library.ts` 的流）和访客界面（`GuestApp`）共用这一份实现。
 * 只接一侧是不行的：摄影师看不到客户刚做的标记，正是这套东西存在的理由。
 *
 * ── 三条必须成立的规则 ──────────────────────────────────────────────────
 *
 * 1. **`origin === 自己` 的广播忽略。** 自己那一次写早就乐观更新过了。
 *    回声和自己那次 PUT 的响应之间没有顺序保证，让回声有发言权就是给
 *    "按下 P 之后闪一下"开一扇窗。
 * 2. **本地对某个 id 还有未落地的写时，丢弃该 id 的远端广播**（在
 *    `store/marks.ts` 的 `applyRemote` 里落实，判据是那边的在飞计数）。
 *    保护只覆盖那个 id——同一帧里别的 id 照常应用。
 * 3. **重连成功后必须全量拉一次 marks。** SSE 只推增量，断开期间别人改的
 *    标记不会补发。
 */

export type BlockKind = 'kicked' | 'share-ended';

export interface BlockState {
  kind: BlockKind;
  /** 服务端给的机器码（'disabled' / 'deleted' / 'revoked' / 'expired'）。 */
  reason: string | null;
}

interface RealtimeState {
  /** 非 null 即"这个界面已经走不下去了"，调用方据此渲染整页阻断层。 */
  blocked: BlockState | null;
}

// 这份状态刻意不放进 store/session.ts：被踢和分享结束是**实时通道**的终局，
// 不是身份的一部分——会话 store 里放一个只有 SSE 会写的字段，会让"我是谁"
// 和"连接还在不在"这两件事混在一起。
export const useRealtime = create<RealtimeState>(() => ({ blocked: null }));

/**
 * 新的一次订阅开始前复位。GuestApp 挂载、library.open()/close() 时调用。
 *
 * 在线名单一并清空：它整份都是从这条流派生出来的（服务端的口径就是
 * "一条活着的 SSE 连接 = 一个在线的人"），流没了却还挂着上一次的名单，
 * 显示的就是一屏早已不在的人。新的一次订阅连上后服务端会立刻推一份完整快照。
 */
export function resetRealtime() {
  useRealtime.setState({ blocked: null });
  setSession({ online: [] });
}

/**
 * 当前这个前端在广播的 `origin` 字段里长什么样。
 * 管理员没有用户记录，服务端固定用 `'admin'`（见 server/routes/marks.js 的
 * `actorOf`）；身份还没解析出来时返回 null——那时不该有任何广播被认领成自己的。
 */
export function selfOrigin(): string | null {
  return actorId();
}

/** 广播体：`{ id: { mark, by, at } }`，清除标记时 `mark` 为 null。 */
interface MarkChange {
  mark: Mark | null;
  by?: string;
  at?: number;
}

function applyMarksBroadcast(event: { origin?: unknown; changes?: unknown }) {
  // 规则 1。origin 缺失时不当成自己的——宁可多合并一次（幂等），
  // 也不要因为一个认不出的帧把别人的改动整批丢掉。
  const self = selfOrigin();
  if (self !== null && event.origin === self) return;

  const changes = event.changes;
  if (!changes || typeof changes !== 'object') return;

  // 标记值和归属（by / at）都摊平之后交给 marks store 的 applyRemote ——
  // **两者必须走同一个入口**：未落地写的丢弃规则在那边，绕过它就等于绕过规则 2。
  // 归属尤其不能在这里直接 set：本地乐观更新已经把标记改成我的了，这一帧带的
  // 却是我按下 P 之前那个人，盖上去就是「标记是我的、角标显示成别人的」。
  const flat: Record<string, Mark | null> = {};
  const meta: Record<string, MarkBy> = {};
  for (const [id, change] of Object.entries(changes as Record<string, MarkChange | null>)) {
    flat[id] = change?.mark ?? null;
    if (typeof change?.by === 'string' && typeof change?.at === 'number') {
      meta[id] = { by: change.by, at: change.at };
    }
  }
  useMarks.getState().applyRemote(flat, meta);
}

function applyRoleChange(event: { userId?: unknown; role?: unknown }) {
  const { user } = useSession.getState();
  // 服务端只把 role 事件发给当事人自己的连接，但客户端不拿这个当保证：
  // 认错人就会把自己的权限改成别人的。
  if (!user || event.userId !== user.id) return;
  if (event.role !== 'viewer' && event.role !== 'editor') return;
  setSession({ user: { ...user, role: event.role as Role } });
}

/**
 * 路由一帧 SSE 事件。返回 true 表示这一帧由本模块认领并处理完毕，
 * 调用方不必再看；返回 false 的帧（meta / metaDone / bake / scan / error）
 * 归调用方自己。
 */
export function handleRealtimeEvent(event: any): boolean {
  switch (event?.type) {
    case 'marks':
      // 已经被阻断之后不再合并任何东西：界面已经换成阻断层，改背后那份
      // 看不见的状态没有意义，只会让"被踢之后仍在跟着别人动"这件事成立。
      if (!useRealtime.getState().blocked) applyMarksBroadcast(event);
      return true;

    case 'presence':
      setSession({ online: Array.isArray(event.users) ? (event.users as OnlineUser[]) : [] });
      return true;

    case 'role':
      applyRoleChange(event);
      return true;

    case 'kicked':
      useRealtime.setState({ blocked: { kind: 'kicked', reason: reasonOf(event) } });
      return true;

    case 'share-ended':
      useRealtime.setState({ blocked: { kind: 'share-ended', reason: reasonOf(event) } });
      return true;

    case 'hidden':
      // 隐藏对所有人生效，访客也要收。整份覆盖，不做增量合并——
      // 它是一个几百条的字符串数组，两端各维护一套合并规则不值得。
      if (!useRealtime.getState().blocked) {
        useMarks.getState().applyRemoteHidden((event as { hidden?: unknown }).hidden);
      }
      return true;

    default:
      return false;
  }
}

function reasonOf(event: { reason?: unknown }): string | null {
  return typeof event.reason === 'string' ? event.reason : null;
}

/**
 * 全量补拉标记，并以服务端快照收敛本地状态。
 *
 * 失败**不**上报成错误提示：补拉是一次后台修复动作，用户没有发起过它，
 * 为它弹一条"保存失败"式的红字只会让人以为自己刚做的操作出了问题。
 * 连接不好的话 EventSource 还会继续重连，下一次连上会再试一次。
 */
export async function refetchMarks(): Promise<void> {
  if (useRealtime.getState().blocked) return;
  try {
    const res = await getJSON<{ marks: Record<string, Mark>; marksMeta?: unknown; hidden?: unknown }>(
      '/api/library/marks');
    // 等待期间可能刚好被踢/分享结束，那时这份数据已经没有落地的意义。
    if (useRealtime.getState().blocked) return;
    // 归属跟着一起收敛：断开期间别人改过的那些片，标记补回来了而角标还停在
    // 上一个人身上的话，这份"谁选的"就成了一份越用越旧的假消息。
    useMarks.getState().reconcile(res.marks ?? {}, res.marksMeta);
    // hidden 同理：断开期间别人隐藏/取消隐藏的那些，不补拉就会一直显示旧的一份。
    useMarks.getState().applyRemoteHidden(res.hidden);
  } catch { /* 见上：补拉失败是后台的事，不打扰用户 */ }
}

/**
 * 造一个给 `openStream` 用的 `onOpen` 回调：**跳过第一次**建立连接，
 * 之后每一次（EventSource 自动重连成功）都全量补拉。
 *
 * 第一次要跳过，是因为订阅总是紧跟在一次完整的 `GET /api/library/marks`
 * 之后建立的（`library.open()` 与 `GuestApp` 都是这个顺序），那一刻再拉一次
 * 是纯粹多余的一趟往返。
 *
 * 状态放在闭包里而不是模块级：每条订阅各造一份，换文件夹、重新挂载
 * 都自然从头开始，不需要谁记得去复位一个全局标志。
 */
export function createReconnectRefetch(): () => void {
  let opened = false;
  return () => {
    if (!opened) { opened = true; return; }
    void refetchMarks();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 阻断层文案
// ─────────────────────────────────────────────────────────────────────────────

const KICKED_MESSAGE: Record<string, string> = {
  disabled: '摄影师暂停了你的访问权限。',
  deleted: '摄影师把你从这场选片里移除了。',
};

const ENDED_MESSAGE: Record<string, string> = {
  revoked: '摄影师撤销了这条分享链接。',
  expired: '这条分享链接已经到期。',
};

/**
 * 把阻断原因翻译成 `Blocker` 的三段文案。
 *
 * `kicked` 和 `share-ended` 必须说得不一样：前者是"只有你被请出去了"，
 * 后者是"这场选片对所有人都结束了"。用同一句话打发两种情形，被踢的人
 * 会以为是链接过期而反复刷新，链接过期的人会以为自己做错了什么去追问摄影师。
 * reason 认不出来时退回一句不猜原因、但仍然说清"发生了什么、下一步找谁"的话。
 */
export function blockerPropsFor(block: BlockState): BlockerProps {
  if (block.kind === 'kicked') {
    return {
      title: '你已被移出这场选片',
      message: KICKED_MESSAGE[block.reason ?? ''] ?? '摄影师结束了你在这场选片里的访问权限。',
      detail: '你之前做过的标记都已经保存，不会丢失。需要继续参与请联系摄影师。',
    };
  }
  return {
    title: '这场选片已经结束',
    message: ENDED_MESSAGE[block.reason ?? ''] ?? '这条分享链接已经不再有效。',
    detail: '大家做过的标记都已经保存。还需要看这批照片的话，请向摄影师索要新链接。',
  };
}
