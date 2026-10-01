import { useMemo } from 'react';
import { useSession } from '../store/session';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { barMembers } from '../lib/derive';
import { avatarColor, avatarInitial } from '../lib/avatar';

/**
 * 成员条（规格 §7.5）。
 *
 * 在线名单来自 SSE 的 `presence` 事件——服务端按"一条活着的 SSE 连接 = 在线"
 * 派生，同一个人开三个标签页也只出现一次。**离线的人不会消失**：只要他在
 * contrib 里标过照片就继续留在条上（灰掉），因为他标过的照片还挂在网格里，
 * 条上找不到他就等于那些头像是个死链接。谁显示谁不显示的规则在 barMembers。
 *
 * 一个人都没有时渲染 `null` 而不是一条空条子：单机使用（不开分享）时永远是
 * 这种情况，界面不该因为多了一套协同功能就凭空多出一条永远空着的横栏。
 *
 * 颜色和首字都来自 `lib/avatar.ts`：**颜色由 userId 派生、首字由昵称派生**。
 * 两者的来源不同不是笔误——重名的人必须有不同的颜色（否则色块就白挂了），
 * 而首字要跟着人看得懂的名字走。
 *
 * 点头像按这个人筛选，是**管理员专属**：访客那边服务端根本不下发别人的
 * contrib，筛出来只会是空的。三道防线的第二道是「干脆不渲染成按钮」而不是
 * 置灰——只读界面只展示有权限的操作。
 */
export function PresenceBar() {
  const online = useSession((s) => s.online);
  const roster = useSession((s) => s.roster);
  const me = useSession((s) => s.user);
  const canFilter = useSession((s) => s.canHide());
  const contrib = useMarks((s) => s.contrib);
  const clientFilter = useView((s) => s.clientFilter);
  const setClientFilter = useView((s) => s.setClientFilter);

  const members = useMemo(() => barMembers(roster, online, contrib), [roster, online, contrib]);

  if (members.length === 0) return null;

  return (
    <ul className="presence" role="list" aria-label="成员">
      {members.map((u) => {
        const isMe = me != null && u.id === me.id;
        const readonly = u.role === 'viewer';
        const active = clientFilter === u.id;
        // title 里把身份说全：一屏色块之间靠悬停区分谁是谁，而"这个人是只读的"
        // 是摄影师最需要一眼看出的一件事——不知道的话他会一直等一个按 P
        // 根本没反应的人给出选择。离线同理：他不是不选，是已经走了。
        const title = [u.nickname, isMe ? '你' : null, u.isOnline ? null : '已离线',
          readonly ? '只读' : null].filter(Boolean).join(' · ');
        const body = (
          <>
            <span className="presence-dot" style={{ background: avatarColor(u.id) }} aria-hidden="true">
              {avatarInitial(u.nickname)}
            </span>
            <span className="presence-name">{u.nickname}</span>
            {readonly && <span className="presence-role">只读</span>}
          </>
        );
        const cls = [
          'presence-item',
          isMe ? 'presence-me' : '',
          u.isOnline ? '' : 'presence-off',
          active ? 'presence-active' : '',
        ].filter(Boolean).join(' ');

        return (
          <li key={u.id} className={cls} title={title}>
            {canFilter ? (
              <button
                type="button"
                className="presence-btn"
                aria-pressed={active}
                aria-label={`${title} · ${active ? '正在按他筛选，点击取消' : '点击只看他标过的'}`}
                onClick={() => setClientFilter(active ? null : u.id)}
              >
                {body}
              </button>
            ) : body}
          </li>
        );
      })}
    </ul>
  );
}
