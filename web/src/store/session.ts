import { create } from 'zustand';
import { getJSON } from '../lib/api';

export type Role = 'viewer' | 'editor';

export interface SessionUser {
  id: string;
  nickname: string;
  role: Role;
}

export interface SessionShare {
  label: string;
}

/** 在线成员条目。role 是宽字符串（不是 Role）——管理员的 'admin' 也要能装进这个数组。 */
export interface OnlineUser {
  id: string;
  nickname: string;
  role: string;
}

export interface SessionState {
  /** 当前这个前端是谁：本地管理员、某条分享下的访客、还是尚未确定身份。 */
  kind: 'admin' | 'user' | 'none';
  user: SessionUser | null;
  share: SessionShare | null;
  online: OnlineUser[];
  /**
   * 参与过当前文件夹的人（含已离线的）。只有管理员会去拉。
   *
   * 与 online 正交：online 回答「在不在线」，roster 回答「叫什么名字」。
   * 照片上那个头像的昵称必须从这里查——客户关掉网页之后 online 里就没有他了，
   * 而他标过的照片还在，头像不该因此变成一个问号。
   */
  roster: { id: string; nickname: string }[];
  selectionLocked: boolean;
  loadRoster: () => Promise<void>;
  /** admin 或者 role === 'editor' 才能发出写请求；viewer 与身份未定一律 false。 */
  canWrite(): boolean;
  /**
   * 能不能隐藏照片。**只有管理员**——隐藏改变的是所有人眼前的那一屏，
   * 而它没有撤销入口。和导出同一档，不设"信任的客户"这一档。
   *
   * 单独一个方法而不是让调用方就地写 `kind === 'admin'`：它是整个前端唯一
   * 一份「能不能隐藏」的判断，再写一份等于给自己留一个将来两处不一致的接缝。
   */
  canHide(): boolean;
}

const INITIAL: Pick<SessionState, 'kind' | 'user' | 'share' | 'online'> = {
  kind: 'none',
  user: null,
  share: null,
  online: [],
};

export const useSession = create<SessionState>((set, get) => ({
  ...INITIAL,
  roster: [],
  selectionLocked: false,
  async loadRoster() {
    // 访客拿不到这个端点（admin-only），拉失败就维持空名册——
    // 昵称退回「已离开的成员」是可接受的降级，整个界面不该因此报错。
    try {
      const { users } = await getJSON<{ users: { id: string; nickname: string }[] }>(
        '/api/admin/library-users');
      set({ roster: users });
    } catch { /* 访客或未开库，保持空 */ }
  },
  canWrite() {
    const { kind, user, selectionLocked } = get();
    return kind === 'admin' || (user?.role === 'editor' && !selectionLocked);
  },
  canHide() { return get().kind === 'admin'; },
}));

/**
 * 当前这个前端在服务端眼里的 actor id —— 广播的 `origin`、以及标记归属表
 * （`marksMeta[id].by`）里写的就是它。管理员没有用户记录，服务端固定用
 * `'admin'`（见 server/routes/marks.js 的 `actorOf`）。
 *
 * 身份还没解析出来时返回 `null`：那时既不该把任何广播认领成自己的，
 * 也不该给自己刚做的标记安一个猜出来的归属——宁可不显示角标，
 * 也不能显示一个错的。
 *
 * 放在 session store 而不是 realtime.ts，是因为 store/marks.ts 也要用它
 * （乐观更新时要知道"这条标记是谁做的"），而 realtime.ts 依赖 marks.ts，
 * 反过来 import 就成了模块环。
 */
export function actorId(): string | null {
  const { kind, user } = useSession.getState();
  if (kind === 'admin') return 'admin';
  return user?.id ?? null;
}

/**
 * 便捷写入口，等价于 `useSession.setState(partial)`。
 * JoinGate/GuestApp/realtime.ts（Task 15-17）在拿到 join/resume 的响应、
 * 或者收到 SSE 的 presence/role/kicked 事件时，用它把新状态灌进 store；
 * 它们的测试也用同一个函数直接摆状态，不需要知道 zustand 的 setState 细节。
 */
export function setSession(partial: Partial<SessionState>) {
  useSession.setState(partial);
}
