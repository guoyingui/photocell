/** 本机监听常驻；局域网使用单独端口，关闭分享不会中断摄影师的选片与导出。 */
export class NetworkController {
  constructor(app, localServer, listen) {
    this.app = app; this.localServer = localServer; this.listen = listen;
    this.lanServer = null; this.tail = Promise.resolve();
  }
  get enabled() { return Boolean(this.lanServer?.listening); }
  get port() { return this.lanServer?.address()?.port ?? null; }
  setEnabled(enabled) {
    const result = this.tail.then(async () => {
      if (enabled === this.enabled) return;
      if (enabled) {
        const localPort = this.localServer.address().port;
        this.lanServer = await this.listen(this.app, localPort >= 5183 && localPort <= 5199 ? localPort + 1 : 0,
          localPort >= 5183 && localPort <= 5199 ? Math.max(1, 5199 - localPort) : 1, '0.0.0.0');
      } else {
        const server = this.lanServer; this.lanServer = null;
        if (server) {
          const closed = new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
          server.closeAllConnections();
          await closed;
        }
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async close() {
    await this.setEnabled(false);
    const closed = new Promise((resolve) => this.localServer.close(resolve));
    this.localServer.closeAllConnections(); await closed;
  }
}
