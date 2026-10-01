export interface BlockerProps {
  /** 大标题。默认给一个通用的措辞；调用方按具体场景传更贴切的（如"你已被移出"）。 */
  title?: string;
  /** 给人看的具体原因。链接失效时来自服务端 message；被踢/分享结束时由调用方翻译。 */
  message: string;
  /** 补充说明，比如"请向摄影师索要新链接"。可选。 */
  detail?: string;
}

/**
 * 整页阻断层。三类"这个界面已经走不下去了"的场景共用同一个组件：
 * 链接无效（Task 15 的 JoinGate）、被管理员踢出、分享被撤销/过期时仍在线
 * （Task 17 的 kicked / share-ended）。
 *
 * 纯展示组件：不发请求、不读 store、不提供任何"绕过去"的按钮或链接——
 * 阻断就是阻断，调用方决定何时渲染它，渲染出来之后这一屏不再有别的入口。
 * `role="alert"` 让屏幕阅读器在它出现时立刻读出来，不需要用户主动去找。
 */
export function Blocker({ title = '无法继续', message, detail }: BlockerProps) {
  return (
    <div className="blocker" role="alert">
      <h1>{title}</h1>
      <p>{message}</p>
      {detail && <p className="blocker-detail muted">{detail}</p>}
    </div>
  );
}
