import { useMemo, useState } from 'react';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import { useView } from '../store/view';
import { assetsInDir, countByTab, countByTabForClient } from '../lib/derive';
import type { FilterTab } from '../types';
import { basename } from '../lib/pathname';
import { SharePanel } from './SharePanel';
import { MarkBar } from './MarkBar';
import { CompareButton } from './CompareButton';
import { HistoryButtons } from './HistoryButtons';
import { ThemeToggle } from './ThemeToggle';

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pick', label: '收藏' },
  { key: 'reject', label: '排除' },
  { key: 'none', label: '未标记' },
];

/**
 * 第五个 tab 只有管理员看得到：隐藏是摄影师的操作，客户那侧没有这个概念。
 *
 * 单列一个常量而不是在 TABS 里加一项再过滤，是为了让「四个所有人都看得到 +
 * 一个只有管理员看得到」这件事在数据上就是显式的——写成过滤的话，将来往
 * TABS 里插一项的人得先读懂过滤条件才知道自己插的那项会不会漏给访客。
 */
const HIDDEN_TAB: { key: FilterTab; label: string } = { key: 'hidden', label: '已隐藏' };

export function TopBar({ onExport, order = [] }: { onExport: () => void; order?: string[] }) {
  // 逐字段订阅：像 Grid/StackCell/Thumb 一样，只订阅真正影响这个组件渲染的
  // 字段。之前整体解构 useLibrary()/useView() 会让 TopBar 订阅到 cursor、
  // selection、lightbox、anchor、expanded 这些和顶栏渲染毫无关系的字段——
  // zustand 每次 set() 都会替换整个 store 对象，方向键、点选、展开收起这些
  // 高频操作都会白白触发一次 TopBar 重渲染，并连带把下面 4×filterAssets 的
  // 计数重新跑一遍。
  const root = useLibrary((s) => s.root);
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const bake = useLibrary((s) => s.bake);
  const streamError = useLibrary((s) => s.streamError);
  const close = useLibrary((s) => s.close);
  // 服务端拒绝了这次"换文件夹"，因为该会话上还有访客在线（规格 §5.4）。
  const closeBlocked = useLibrary((s) => s.closeBlocked);
  const dismissCloseBlock = useLibrary((s) => s.dismissCloseBlock);
  const refresh = useLibrary((s) => s.refresh);
  const refreshing = useLibrary((s) => s.refreshing);
  const refreshResult = useLibrary((s) => s.refreshResult);
  const dismissRefreshResult = useLibrary((s) => s.dismissRefreshResult);
  const marks = useMarks((s) => s.marks);
  const hidden = useMarks((s) => s.hidden);
  const tab = useView((s) => s.tab);
  const setTab = useView((s) => s.setTab);
  const dirFilter = useView((s) => s.dirFilter);
  // 只读时整个开关不渲染。置灰不行：只读界面只展示有权限的操作。
  const canWrite = useSession((s) => s.canWrite());
  const canHide = useSession((s) => s.canHide());
  const roster = useSession((s) => s.roster);
  const online = useSession((s) => s.online);
  const contrib = useMarks((s) => s.contrib);
  const clientFilter = useView((s) => s.clientFilter);

  // 分享面板的开关状态只在这里维护：TopBar 是本地界面（admin-only 的 `/`）
  // 特有的入口，App.tsx 不需要知道它开着还是关着，就像 ExportPanel 那样
  // 用一个本地 state 就够了，不需要提到父组件。
  const [shareOpen, setShareOpen] = useState(false);

  // 四个 tab 的计数只取决于 assets/marks/dirFilter，和当前选中哪个 tab、
  // 光标在哪、有没有展开连拍组都无关——记忆化后，光标移动/框选/展开收起
  // 都不会再让这些 O(n) 扫描重新执行一遍。
  //
  // 再拆一层：目录过滤跟 marks 无关，单独记忆化之后，每按一次 P/X 只剩
  // countByTab 这一趟遍历，而不是四次全库 filterAssets。
  const inDir = useMemo(
    () => assetsInDir(assets, dirFilter), [assets, dirFilter]);
  // 筛了人之后计数必须换口径，否则页签上写着 12 张、点进去只有 9 张。
  const counts = useMemo(
    () => (clientFilter === null
      ? countByTab(inDir, marks, hidden)
      : countByTabForClient(inDir, contrib, clientFilter, hidden)),
    [inDir, marks, hidden, clientFilter, contrib],
  );
  const tabs = canHide ? [...TABS, HIDDEN_TAB] : TABS;

  // 筛了人之后「全部」不再等于整库，而是等于「他碰过的」（= 收藏 + 排除）。
  // 数字对不上的疑虑靠文案消解：那一格直接改叫「新娘碰过的」，
  // 不留一个名字叫「全部」、数字却比整库小的格子让人自己猜。
  const filteredName = clientFilter === null
    ? null
    : (roster.find((u) => u.id === clientFilter)?.nickname
      ?? online.find((u) => u.id === clientFilter)?.nickname
      ?? '这个人');

  const baking = bake.total > 0 && bake.done < bake.total;

  return (
    <header className="topbar">
      <button className="btn-folder" onClick={() => void close()}>选择文件夹</button>

      {/* 刷新不退回选择器：旧网格继续显示到扫完。这是它和「换文件夹」
          最重要的区别，也是「选片过程中照片被移动或删除」这个场景要的东西。 */}
      {/* 只读时整个按钮不渲染，理由同下面的「多选」：刷新是 admin-only
          （服务端已经是 requireAdmin），这里是前端第二道防线，置灰不行——
          访客的顶栏不该看到这个按钮存在过。 */}
      {canWrite && (
        <button className="btn-refresh" onClick={() => void refresh()} disabled={refreshing}
                title="重新扫描这个文件夹。选片进度不会丢">
          {refreshing ? '正在刷新…' : '刷新'}
        </button>
      )}

      <code title={root ?? ''}>{root ? basename(root) : ''}</code>

      <nav className="tabs">
        {tabs.map((t, i) => (
          <button key={t.key} className={tab === t.key ? 'tab tab-on' : 'tab'}
                  onClick={() => setTab(t.key)} title={`快捷键 ${i + 1}`}>
            {t.key === 'all' && filteredName !== null ? `${filteredName}碰过的` : t.label} <b>{counts[t.key]}</b>
          </button>
        ))}
      </nav>

      <CompareButton order={order} />
      <HistoryButtons />
      <MarkBar />

      <span className="muted">
        {metas.size < assets.length ? `读取元数据 ${metas.size}/${assets.length}` : ''}
        {baking ? ` 缓存 ${bake.done}/${bake.total}` : ''}
      </span>

      {streamError && <span className="error">{streamError}</span>}

      {refreshResult && (refreshResult.removed > 0 || refreshResult.added > 0) && (
        <button className="refresh-result" onClick={dismissRefreshResult}
                title="点一下关掉这条提示">
          {refreshResult.removed > 0 && `${refreshResult.removed} 张已不在磁盘上`}
          {refreshResult.removed > 0 && refreshResult.added > 0 && ' · '}
          {refreshResult.added > 0 && `新增 ${refreshResult.added} 张`}
        </button>
      )}

      {/* 原来只有导出按钮靠 `.topbar > .primary { margin-left: auto }` 单独
          推到最右边；现在两个按钮要一起靠右，所以包一层容器统一处理
          （见 styles.css 的 `.topbar-actions`），而不是给"分享"也加一份
          容易和"导出"打架的 auto margin。 */}
      <div className="topbar-actions">
        <ThemeToggle />
        <button className="btn-share" onClick={() => setShareOpen(true)}>分享…</button>
        <button className="primary" onClick={onExport}>导出…</button>
      </div>

      <SharePanel open={shareOpen} onClose={() => setShareOpen(false)} />

      {closeBlocked && (
        <GuestsOnlineConfirm
          message={closeBlocked.message}
          onRevoke={() => { dismissCloseBlock(); setShareOpen(true); }}
          onForce={() => void close(true)}
          onCancel={dismissCloseBlock}
        />
      )}
    </header>
  );
}

/**
 * "还有 N 位访客在线"的确认框（规格 §5.4）。
 *
 * 三个出口，顺序就是推荐程度：
 *
 * 1. **去撤销链接**——规格要求的"直达撤销的入口"。这是唯一真正结束访问的动作：
 *    关掉文件夹只是摄影师这一侧脱离，客人手里那条链接还是有效的，
 *    他刷新一下、或者明天再点开，只要摄影师又打开了这个文件夹就又能看。
 * 2. **仍然关闭**——`danger`，因为它会把正在看图的人当场断掉。
 * 3. **取消**——默认。误按"换文件夹"是很常见的事。
 *
 * 文案**原样来自服务端**，这里一个字都不拼。在线人数、"链接仍然有效"、
 * "要真正结束访问请去撤销"这三句必须来自同一个知道真相的地方；前端自己
 * 拼一份，迟早会跟服务端说的不一样，而不一样的那一刻没有任何东西会报错。
 *
 * `role="alertdialog"` 而不是 `dialog`：它是对一个**已经被拒绝的操作**的回应，
 * 需要立刻被读屏软件念出来。
 */
function GuestsOnlineConfirm({ message, onRevoke, onForce, onCancel }: {
  message: string;
  onRevoke: () => void;
  onForce: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-box guests-online" role="alertdialog" aria-modal="true"
           aria-labelledby="guests-online-title">
        <h2 id="guests-online-title">这个文件夹还有人在看</h2>
        <p className="guests-online-msg">{message}</p>
        <div className="modal-actions">
          <button className="primary" onClick={onRevoke}>去撤销链接…</button>
          <button className="danger" onClick={onForce}>仍然关闭</button>
          <button onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}
