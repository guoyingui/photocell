import { useEffect, useRef, useState } from 'react';
import { applyHidden } from '../lib/applyMark';
import { consumeClickSwallow } from '../lib/marquee';
import { useThumb } from '../lib/thumbSource';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import type { SessionState } from '../store/session';
import { useView } from '../store/view';
import { useReview } from '../store/review';
import { useAnnotations } from '../store/annotations';
import { LABELS, STAGES } from '../../../shared/annotations.js';
import { avatarColor, avatarInitial } from '../lib/avatar';
import type { Asset } from '../types';

interface Props {
  asset: Asset;
  priority: number;
  visible: boolean;
  compact?: boolean;
  /** 给 Shift+点击做范围选。没有的话 Shift 退化为只选这一张。 */
  order?: string[];
}

/** 归属时间用本地时区、固定格式手拼，不走 Intl：跨机器、跨 ICU 版本都是同一串字。 */
const pad = (n: number) => String(n).padStart(2, '0');
function stampOf(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 归属里的人已经不在线（或者根本没参加过这条分享）时的说法。 */
const GONE_NAME = '已离开的成员';

/**
 * 把归属里的 userId 翻成看得懂的名字。
 *
 * 三个来源按这个顺序：管理员（服务端固定用 `'admin'`，没有用户记录）、
 * 自己（访客刚进来时未必已经出现在 presence 快照里）、名册（Task 21：
 * 含已离线的人，查的是 roster 不是 online）。
 * 都查不到就返回 null——标记会留在文件里、人却会走，这是常态而不是异常。
 * 那时宁可说"不知道是谁"，也不能把这条标记冒认成名册里的另一个人。
 */
function nicknameFor(s: SessionState, by: string): string | null {
  if (by === 'admin') return '摄影师';
  if (s.user?.id === by) return s.user.nickname;
  // 从**名册**查，不是从 online 查：online 只有此刻连着的人，
  // 客户关掉网页之后他标过的照片还在，头像不该跟着退化成问号。
  return s.roster.find((u) => u.id === by)?.nickname ?? null;
}

export function Thumb({ asset, priority, visible, compact, order }: Props) {
  const { url, failed } = useThumb(asset.id, priority, visible);
  const mark = useMarks((s) => s.marks[asset.id]);
  // 归属（Task 20）。旧文件夹、以及一直单机用的文件夹根本没有这张表，
  // 这里就是 undefined —— 不显示角标，不报错。
  const by = useMarks((s) => s.marksMeta[asset.id]);
  // 选择器返回的是字符串而不是整份名单：presence 每变一次就重渲染全屏格子
  // 是不能接受的，而昵称没变时这个订阅根本不会触发。
  const byId = by?.by ?? null;
  const nickname = useSession((s) => (byId === null ? null : nicknameFor(s, byId)));
  const cursor = useView((s) => s.cursor);
  const selected = useView((s) => s.selection.has(asset.id));
  const setCursor = useView((s) => s.setCursor);
  const openLightbox = useView((s) => s.openLightbox);
  const toggleSelect = useView((s) => s.toggleSelect);
  const canHide = useSession((s) => s.canHide());
  const inHiddenTab = useView((s) => s.tab === 'hidden');
  const seen = useReview((s) => s.reviewed.has(asset.id));
  const annotation = useAnnotations((s) => s.annotations[asset.id]);

  const imgRef = useRef<HTMLImageElement>(null);
  const [decoded, setDecoded] = useState(false);

  // 先解码再显示，避免解码卡在主线程上造成滚动掉帧
  useEffect(() => {
    setDecoded(false);
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.src = url;
    img.decode().then(() => { if (alive) setDecoded(true); }).catch(() => { if (alive) setDecoded(true); });
    return () => { alive = false; };
  }, [url]);

  const cls = [
    'thumb',
    compact ? 'thumb-compact' : '',
    cursor === asset.id ? 'thumb-cursor' : '',
    selected ? 'thumb-selected' : '',
  ].filter(Boolean).join(' ');

  return (
    <figure
      className={cls}
      data-id={asset.id}
      onClick={(e) => {
        if (consumeClickSwallow()) return;
        if (e.metaKey || e.ctrlKey) {
          toggleSelect(asset.id);
          return;
        }
        setCursor(asset.id, { extend: e.shiftKey, order });
      }}
      onDoubleClick={() => openLightbox(asset.id)}
    >
      {url && decoded
        ? <img ref={imgRef} src={url} alt={asset.stem} decoding="async" draggable={false} />
        : <div className={failed ? 'thumb-failed' : 'thumb-skeleton'}>{failed ? '无法预览' : ''}</div>}

      <figcaption>{asset.stem}</figcaption>
      {annotation && (annotation.rating > 0 || annotation.stage !== 'initial' || annotation.label !== 'none') &&
        <span className="thumb-workflow" data-label={annotation.label} title={`${LABELS[annotation.label]} · ${STAGES[annotation.stage]}`}>
          {annotation.rating > 0 && '★'.repeat(annotation.rating)} {annotation.stage !== 'initial' ? STAGES[annotation.stage] : LABELS[annotation.label]}</span>}
      {seen && <span className="thumb-seen" title="已看过">已看</span>}

      {/* 「已隐藏」视图里格子上只留取消隐藏。收藏/排除改走键盘和顶栏批量按钮，
          不再盖在缩略图上。 */}
      {canHide && inHiddenTab && (
        <div className="thumb-actions">
          <button type="button" className="thumb-act thumb-act-unhide"
                  aria-label="取消隐藏"
                  onClick={(e) => {
                    e.stopPropagation();
                    applyHidden(false, { targets: [asset.id] });
                  }}>↩</button>
        </div>
      )}

      {/* 最后改这张片的人。颜色由 userId 派生（规格 §7.5：稳定不变），首字跟着
          昵称走——同一个人在成员条和这里必须是同一个颜色，否则色块就白挂了。
          多人一起选片时，"这张是谁选的"是看一屏格子最想知道的一件事。 */}
      {by && (
        <span
          className="thumb-by"
          style={{ background: avatarColor(by.by) }}
          title={`${nickname ?? GONE_NAME} · ${stampOf(by.at)}`}
          role="img"
          aria-label={`最后修改：${nickname ?? GONE_NAME} · ${stampOf(by.at)}`}
        >
          {avatarInitial(nickname ?? '?')}
        </span>
      )}

      {mark === 'pick' && <span className="badge badge-pick" role="img" aria-label="已收藏" title="已收藏">★</span>}
      {mark === 'reject' && <span className="badge badge-reject" role="img" aria-label="已排除" title="已排除">✕</span>}
      {asset.raws.length === 0 && <span className="badge badge-warn" title="没有 RAW 文件">无 RAW</span>}
      {asset.jpg === null && <span className="badge badge-warn" title="纯 RAW，尝试内嵌 JPEG 预览">纯 RAW</span>}
    </figure>
  );
}
