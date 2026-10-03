import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import { useView } from '../store/view';
import { useReview } from '../store/review';
import type { Mark } from '../types';

/**
 * 标记作用在哪些资产上：有选区就是整个选区，否则就是光标那一张。
 *
 * 单独拆出来是因为这是"跨文件夹残留"最危险的一条路径：selection 里存的是上一个
 * 文件夹的 id，而同一台相机的两场拍摄天然共享 id（IMG_0002）。换文件夹时如果
 * useView 不复位，在新文件夹里按一下 P 就会静默标记一张用户根本没在看的照片，
 * 并且直接流进导出。useLibrary.open() 里的 useView.reset() 是唯一的防线。
 */
export function markTargets(view: {
  selection: Set<string>; cursor: string | null;
}): string[] {
  if (view.selection.size > 0) return [...view.selection];
  return view.cursor ? [view.cursor] : [];
}

export interface ApplyMarkOptions {
  /** 省略时用 markTargets(view)。按钮传自己那一张（或整个选区）。 */
  targets?: string[];
  /**
   * 传了才推进光标，并且推进算法要用它。键盘传（连续选片要自动前进），
   * 按钮不传，批量操作后由操作条清空选区。
   */
  order?: string[];
}

/**
 * 把光标推到「这一批之后、仍然留在视图里」的那一张。标记和隐藏共用。
 *
 * `gone` 是这次操作之后**离开当前视图**的那些 id。两个调用方给的东西不一样：
 * 标记给的是整批 targets，隐藏给的是 eligible ——被跳过的（已有标记、藏不了的）
 * 那些**没有**离开视图，它们是完全合法的落点，把它们一起排除会把光标推得比
 * 该去的地方更远。
 *
 * 推进本身符合连续选片的手感，但真正的理由是它下面那半段：如果刚操作的是当前
 * 视图里的最后一张，order 里已经没有"下一张"了——这时不能什么都不做，那会把
 * cursor 晾在一个刚刚从视图里消失的 id 上，下一次方向键会因为
 * order.indexOf(cursor) === -1 走进 useKeyboard.ts 的 Math.max(0, at + delta)，
 * 结果是**跳回列表第一张**，体验上就是键盘导航"失忆"。所以退而求其次，找这批
 * 之前最近一个还留在视图里的 id；连这个也找不到，说明这一屏已经空了，只能清掉。
 */
function advanceCursor(
  view: ReturnType<typeof useView.getState>, gone: string[], order: string[],
): void {
  const goneSet = new Set(gone);
  const at = order.indexOf(gone[gone.length - 1]);
  let fallback: string | undefined;
  if (at !== -1) {
    for (let i = at + 1; i < order.length; i++) {
      if (!goneSet.has(order[i])) { fallback = order[i]; break; }
    }
    if (!fallback) {
      const from = order.indexOf(gone[0]);
      for (let i = from - 1; i >= 0; i--) {
        if (!goneSet.has(order[i])) { fallback = order[i]; break; }
      }
    }
  }

  // 大图打开时，"下一张"不该只是悄悄挪走网格里那个看不见的 cursor——大图和
  // 网格必须一起走到下一张，否则用户在全屏里连续剔片，屏幕上却一直停在第一张
  // 不动；退出大图时网格光标也会和最后看到的画面对不上。openLightbox 本身会把
  // selection 收敛成新的单张，天然维持"大图里只影响当前这一张"的不变量。如果
  // 连一张"还留在视图里的下一张"都找不到（这一屏刚好被清空），大图也没有什么
  // 可显示的了，一并关闭并清空 cursor。
  if (view.lightbox) {
    if (fallback) view.openLightbox(fallback);
    else { view.closeLightbox(); view.setCursor(null); }
  } else {
    view.setCursor(fallback ?? null);
  }
}

/**
 * 全前端**唯一**的标记入口。键盘与按钮都走这里。
 *
 * 返回 true 表示这次真的写了。键盘那边靠它决定要不要 preventDefault()——
 * 什么都没标记时不该吞掉按键。
 *
 * ── 只读门禁 ──────────────────────────────────────────────────────────────
 * 这是一条安全属性，不是界面装饰。服务端的 403 read-only 是第一道防线，
 * 组件层的"不渲染"是第二道，这一句是第三道。三道都要有：只靠服务端的话，
 * 乐观更新会先把界面改掉、等 403 回来再回滚——中间那一瞬间「看起来我改成功了」
 * 正是最容易让人误判的状态，而且每点一次就往服务端捶一次注定被拒的请求。
 *
 * 判据用 session.canWrite() 而不是就地写 `role === 'viewer'`：canWrite() 是
 * **默认拒绝**的（身份还没解析出来、kind 是 'none' 时也是 false），而 role
 * 判等是默认放行；并且它是整个前端唯一一份「能不能写」的判断。
 *
 * 每次调用现取，不缓存：权限会在运行期被管理员改掉（SSE 的 role 事件），
 * 闭包里捕获一份就会一直用着改之前的答案。
 */
export function applyMark(mark: Mark | null, opts: ApplyMarkOptions = {}): boolean {
  if (!useSession.getState().canWrite()) return false;

  const view = useView.getState();
  const targets = opts.targets ?? markTargets(view);
  if (targets.length === 0) return false;

  useMarks.getState().setMark(targets, mark);
  useReview.getState().setSeen(targets, true);

  const order = opts.order;
  if (!order) return true;

  // 标记的落点是整批 targets：它们全都离开了当前视图（在「全部」页签下没离开，
  // 但连续选片时"跳过刚处理完的这批"仍然是想要的行为）。
  advanceCursor(view, targets, order);
  return true;
}

/**
 * 全前端**唯一**的隐藏入口。键盘 `H` 与批量操作条都走这里。
 *
 * 返回实际生效的张数与被跳过的张数；没权限或没目标时返回 null
 * （键盘那边靠它决定要不要 preventDefault）。
 *
 * ── 只读门禁 ──────────────────────────────────────────────────────────────
 * 判据用 `session.canHide()` 而不是 `canWrite()`：隐藏比标记更严格，
 * editor 角色的访客能标记但不能隐藏。和 canWrite 一样是**默认拒绝**的。
 */
export function applyHidden(
  hidden: boolean, opts: { targets?: string[]; order?: string[] } = {},
): { hidden: number; skipped: number } | null {
  if (!useSession.getState().canHide()) return null;

  const view = useView.getState();
  const targets = opts.targets ?? markTargets(view);
  if (targets.length === 0) return null;

  // 已标记的不能隐藏（规格 §1.5 不变量 2）。服务端会再过滤一遍并回报
  // 权威结果，这里先算一份是为了**立刻**给出那句"M 张因为已有标记被跳过"——
  // 等一趟往返回来再说的话，用户已经在纳闷刚才那一下是不是没生效了。
  // 取消隐藏不受这条限制：已隐藏的必然未标记，真撞上（脏数据）也不该
  // 把它挡在外面，那会让它永远藏着。
  const marks = useMarks.getState().marks;
  const eligible = hidden ? targets.filter((id) => marks[id] === undefined) : targets;
  const skipped = targets.length - eligible.length;
  if (eligible.length === 0) return { hidden: 0, skipped };

  useMarks.getState().setHidden(eligible, hidden);

  // 和 P/X 一样推进光标，理由也一样（见 advanceCursor）：隐藏之后那张当场从
  // 视图里消失，不推进的话下一次方向键会跳回第一张，"按住 H 连续剔片"变成
  // 反复隐藏第一张照片。在「已隐藏」页签里取消隐藏时照片同样离开视图，
  // 同一套逻辑同样成立。
  //
  // 落点传 eligible 不是 targets：被跳过的那些还在视图里。
  if (opts.order) advanceCursor(view, eligible, opts.order);
  return { hidden: eligible.length, skipped };
}
