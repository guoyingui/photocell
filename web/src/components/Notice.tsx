interface Props {
  /** 主 marks.json 读不出来，服务端从 marks.bak.json 恢复了标记。 */
  marksRecovered: boolean;
  /** 扫描时跳过的非照片文件数。 */
  skippedFiles: number;
  onDismiss: () => void;
}

/**
 * 服务端把这两件事算好、传过来、前端存下来，然后从来没有显示过。
 * 规格 §7 要求"从备份恢复"必须明确提示，§3.2 要求告知跳过的文件数——
 * 尤其是前者：备份可能比摄影师最后一次操作旧，不说的话他会以为看到的就是
 * 自己最后留下的状态，然后照着一份过时的选择去导出。
 *
 * 纯展示组件，状态由调用方给：这样它在没有 DOM 测试环境的仓库里也能被断言。
 */
export function Notice({ marksRecovered, skippedFiles, onDismiss }: Props) {
  if (!marksRecovered && skippedFiles <= 0) return null;

  return (
    <div className={marksRecovered ? 'notice notice-warn' : 'notice'}>
      {marksRecovered && (
        <span>
          <strong>主标记文件读不出来，已从备份 marks.bak.json 恢复。</strong>
          {' '}备份可能比你最后一次操作旧，请先核对一遍收藏和排除再导出。
        </span>
      )}
      {skippedFiles > 0 && <span>已跳过 {skippedFiles} 个非照片文件。</span>}
      <button className="ghost" onClick={onDismiss}>知道了</button>
    </div>
  );
}
