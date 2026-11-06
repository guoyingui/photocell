import { withFileLock } from './jsonstore.js';
import { getSession } from './session.js';

// 与备份共用的库级临界区。只包装已经通过权限及会话校验的最终处理函数，
// 等处理函数真正完成才释放；浏览器中途断开也不会提前释放写锁。
export function serializeLibraryRoutes(router) {
  for (const layer of router.stack) {
    const route = layer.route;
    if (!route || route.methods.get || route.methods.head) continue;
    const last = route.stack.at(-1), handler = last.handle;
    last.handle = (req, res, next) => {
      if (!req.session) return handler(req, res, next);
      return libraryTask(req.session, async () => {
        if (getSession(req.session.id) !== req.session) {
          return res.status(409).json({ error: 'session-gone', message: '会话已失效，请重新打开目录' });
        }
        return handler(req, res, next);
      }).catch(next);
    };
  }
}

export const libraryTask = (session, callback) => withFileLock(`library:${session.root}`, callback);
