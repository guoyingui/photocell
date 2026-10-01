import { useState, type DragEvent as ReactDragEvent } from 'react';
import { useLibrary } from '../store/library';
import { forgetRecent, readRecent, rememberRecent } from '../lib/recent';
import { folderNameFromDrop, locate, type DropHit } from '../lib/dropLocate';
import { DirBrowser } from './DirBrowser';
import { ThemeToggle } from './ThemeToggle';

export function FolderPicker() {
  const [here, setHere] = useState('');
  const [manual, setManual] = useState('');
  // 惰性初始化：挂载时读一次。三个 recent 函数都返回写入后的新列表，
  // 所以之后每次改动直接 setState，不再回头读 localStorage。
  const [recent, setRecent] = useState(readRecent);
  const open = useLibrary((s) => s.open);
  const phase = useLibrary((s) => s.phase);
  const libError = useLibrary((s) => s.error);
  const libErrorDetail = useLibrary((s) => s.errorDetail);

  const choose = async (root: string) => {
    setRecent(rememberRecent(root));
    await open(root);
  };

  const [dropName, setDropName] = useState<string | null>(null);
  const [dropHit, setDropHit] = useState<DropHit>({ kind: 'none' });
  const [dropError, setDropError] = useState<string | null>(null);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [listed, setListed] = useState<{ name: string; path: string }[]>([]);

  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    setDropError(null);
    setDropNotice(null);
    const read = folderNameFromDrop(e.dataTransfer);
    if ('error' in read) {
      setDropName(null);
      setDropHit({ kind: 'none' });
      setDropError(read.error);
      return;
    }
    setDropName(read.name);
    setDropNotice(read.notice ?? null);
    setDropHit(locate(read.name, recent, listed));
  };

  return (
    <div className="picker" data-testid="picker-dropzone"
         onDragOver={(e) => e.preventDefault()}
         onDrop={onDrop}>
      <div className="screen-heading">
        <h1>选择照片文件夹</h1>
        <ThemeToggle />
      </div>

      {/* 拖拽的落点：帮你定位，你点一下确认。浏览器不把绝对路径交给网页，
          所以这里能做的上限就是把候选指出来——它从不替你打开任何东西。 */}
      {dropError && <p className="picker-drop picker-drop-error">{dropError}</p>}
      {dropNotice && <p className="picker-drop">{dropNotice}</p>}
      {dropName && dropHit.kind !== 'none' && (
        <div className="picker-drop picker-drop-hit">
          找到了「{dropName}」：<code>{dropHit.path}</code>
          <button className="primary" onClick={() => void choose(dropHit.path)}
                  disabled={phase === 'scanning'}>打开</button>
        </div>
      )}
      {dropName && dropHit.kind === 'none' && (
        <p className="picker-drop">
          你拖进来的是「{dropName}」，请在下面找到它 —— 浏览器不会把文件夹的完整路径告诉网页，
          所以这一步只能由你点一下。
        </p>
      )}

      {recent.length > 0 && (
        <div className="picker-recent">
          <h2>最近打开</h2>
          {recent.map((p) => (
            // 两个**并列**的按钮，不是嵌套——嵌套 <button> 是非法 HTML，
            // 而且会逼出一堆 stopPropagation 才能让内层不触发外层。
            <div className="picker-recent-row" key={p}>
              <button className="picker-recent-item" onClick={() => void choose(p)}
                      disabled={phase === 'scanning'}>{p}</button>
              {/* title 必须写明"不会动磁盘上的文件夹"：在一个照片程序里，
                  一个紧挨着路径的 ✕ 天然会被读成"删掉这个文件夹"。
                  这句话是这个按钮唯一的澄清机会。
                  ✕ 常驻显示而不是 hover 才出现——操作入口保持可见。
                  也不做二次确认：误删的代价只是少一条快捷方式。 */}
              <button className="picker-recent-del" type="button"
                      aria-label={`不再显示 ${p}`}
                      title="从「最近打开」里移除。不会动磁盘上的文件夹"
                      onClick={() => setRecent(forgetRecent(p))}>✕</button>
            </div>
          ))}
        </div>
      )}

      <DirBrowser
        onLocationChange={setHere}
        onListingChange={setListed}
        highlightName={dropName ?? undefined}
        gotoPath={dropHit.kind === 'listed' ? dropHit.path : undefined}
        maxHeight={Math.round(window.innerHeight * 0.44)}
        rowAction={(d) => (
          <button className="ghost" onClick={() => void choose(d.path)}
                  disabled={phase === 'scanning'}>打开</button>
        )}
      />

      <div className="picker-actions">
        <button className="primary" onClick={() => here && void choose(here)}
                disabled={!here || phase === 'scanning'}>
          {phase === 'scanning' ? '正在扫描…' : '打开当前文件夹'}
        </button>
      </div>

      <div className="picker-manual">
        <input value={manual} onChange={(e) => setManual(e.target.value)}
               placeholder="或直接粘贴绝对路径" />
        <button onClick={() => manual.trim() && void choose(manual.trim())}
                disabled={phase === 'scanning'}>打开</button>
      </div>

      {/* 打不开是一个用户必须先去处理的阻断状态（只读 SD 卡、只读网络挂载、
          磁盘写满、目录属于别的用户），不是一条一闪而过的提示。常驻在选择器上，
          并且把服务端给的原始 errno 文案一并显示——只有它能说清到底卡在哪。 */}
      {libError && (
        <div className="picker-error">
          <strong>{libError}</strong>
          {libErrorDetail && <code>{libErrorDetail}</code>}
        </div>
      )}
    </div>
  );
}
