import { useMemo } from 'react';
import { applyMark } from '../lib/applyMark';
import { dirCounts, dirRejected } from '../lib/derive';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import { useView } from '../store/view';

export function Sidebar({ embedded = false }: { embedded?: boolean }) {
  const assets = useLibrary((s) => s.assets);
  const warnings = useLibrary((s) => s.warnings);
  // 逐字段订阅，避免和 TopBar 同样的问题：整体解构 useView() 会让 Sidebar
  // 在 cursor/selection/expanded 等无关字段变化时也跟着重渲染。
  const dirFilter = useView((s) => s.dirFilter);
  const setDirFilter = useView((s) => s.setDirFilter);
  // marks 是新增的订阅，只为判断"这个目录是不是已经全排除了"。代价是每按一次
  // P/X 这个组件都会重渲染；下面那个 memo 把代价压在一趟 O(assets) 上
  // （见 derive.dirRejected 的注释）。
  const marks = useMarks((s) => s.marks);
  // 隐藏对所有人生效（Task 16）：目录计数、排除计数都要跟着剔除隐藏的那些，
  // 否则一个目录显示 30 张、网格里却只有 12 张点得出来。
  const hidden = useMarks((s) => s.hidden);
  // 只读访客只展示浏览入口，写权限仍由服务端和 applyMark 核对。
  const canWrite = useSession((s) => s.canWrite());

  const dirs = useMemo(() => dirCounts(assets, hidden), [assets, hidden]);
  const rejected = useMemo(() => dirRejected(assets, marks, hidden), [assets, marks, hidden]);

  if (dirs.length <= 1 && warnings.length === 0) return null;

  /**
   * 整批排除的对象是该目录下的**全部**照片，不受当前标签页、当前目录筛选影响：
   * 站在「收藏」标签页上点它，排除的仍然是整个目录，而不是眼前看得见的那几张。
   *
   * 走 applyMark 而不是直接 setMark：那是全前端唯一的标记入口，撤销栈、
   * SSE 广播、归属记录都挂在它上面。不传 order —— 批量操作不该把光标挪走。
   */
  const excludeDir = (dir: string, allRejected: boolean) => {
    const targets = assets.filter((a) => a.dir === dir).map((a) => a.id);
    applyMark(allRejected ? null : 'reject', { targets });
  };

  return (
    <aside className={embedded ? 'sidebar sidebar-embedded' : 'sidebar'} aria-label={embedded ? '当前目录的子文件夹' : '文件夹筛选'}>
      <h2>{embedded ? '子文件夹' : '文件夹'}</h2>
      {/* 「全部」这一行必须和下面各目录行加总一致：用 dirs 的和而不是 assets.length，
          否则库里一有隐藏照片，这里就会比下面所有行加起来还大——跟 dirCounts 剔除
          隐藏资产是同一件事，只是这个聚合按钮不直接调 dirCounts，得自己再加一遍。 */}
      <button className={dirFilter === null ? 'dir dir-on' : 'dir'} onClick={() => setDirFilter(null)}>
        全部 <b>{dirs.reduce((sum, d) => sum + d.count, 0)}</b>
      </button>
      {dirs.map(({ dir, count }) => {
        const label = dir || '（根目录）';
        const allRejected = rejected.get(dir) === count;
        // 第二次是取消整个目录的标记；恢复之前的混合状态应使用撤销。
        const hint = allRejected
          ? `取消排除 ${label} 的 ${count} 张照片`
          : `把 ${label} 的 ${count} 张照片整批排除`;
        return (
          <div className="dir-row" key={dir}>
            <button className={dirFilter === dir ? 'dir dir-on' : 'dir'}
                    onClick={() => setDirFilter(dir)} title={label}>
              {label} <b>{count}</b>
            </button>
            {canWrite && (
              <button type="button" aria-label={hint} title={hint}
                      className={allRejected ? 'dir-exclude dir-exclude-on' : 'dir-exclude'}
                      onClick={() => excludeDir(dir, allRejected)}>✕</button>
            )}
          </div>
        );
      })}

      {warnings.length > 0 && (
        <details className="warnings">
          <summary>{warnings.length} 条扫描提示</summary>
          <ul>{warnings.slice(0, 50).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
    </aside>
  );
}
