import { useState } from 'react';
import { ShareList } from './ShareList';
import { UserList } from './UserList';
import { EventLog } from './EventLog';

/**
 * 管理后台外壳（规格 §7.4）：单页三栏——分享列表 -> 该分享的用户 -> 操作日志。
 *
 * 只在 `/admin` 路由下渲染，且服务端的 `requireAdmin` 只放行回环地址
 * （或带对头的 `--admin-token`）发出的请求（server/middleware/auth.js）——
 * 这里不重复做身份判断，三个子面板各自打 `/api/admin/*` 时，
 * 真正的门禁在服务端。
 *
 * 三个子面板都是"自给自足"的容器：各自持有自己的数据和加载状态，
 * 这里只负责传一个 `selectedShareId` 下去，让用户面板和日志面板知道
 * 当前在看哪一条分享。选中态特意放在这一层而不是下沉到 ShareList 内部，
 * 因为它同时是另外两个面板的输入。
 */
export function AdminApp() {
  const [selectedShareId, setSelectedShareId] = useState<string | null>(null);

  return (
    <div className="admin">
      <div className="admin-col admin-col-shares">
        <ShareList selectedId={selectedShareId} onSelect={setSelectedShareId} />
      </div>
      <div className="admin-col admin-col-users">
        <UserList shareId={selectedShareId} />
      </div>
      <div className="admin-col admin-col-events">
        <EventLog shareId={selectedShareId} />
      </div>
    </div>
  );
}
