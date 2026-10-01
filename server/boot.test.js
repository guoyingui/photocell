import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'index.js');

/**
 * 真的把 server/index.js 当成一个程序启动起来。
 *
 * 为什么需要这一条：全套 1268 个用例里没有任何一个走过这条路径——它们全都
 * 直接 `import { createApp }`，于是"自启动守卫"这段代码从来没有被执行过。
 * 结果是一个静默的、彻底的失败：`node server/index.js` 退出 0，不监听、不报错、
 * 什么都不打印，而所有测试照样全绿。
 *
 * 真实成因：守卫写的是 `import.meta.url === \`file://${process.argv[1]}\``，
 * 而 import.meta.url 会把路径里的非 ASCII 字符百分号编码，process.argv[1] 不会。
 * 本仓库的目录名叫「选图程序」，两者永不相等。任何路径含空格、中文、
 * 或其它需要转义字符的用户都会撞上同一件事——而这是用户尝试的**第一个**动作。
 */
function bootServer(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 别让测试进程去开浏览器，也别让它碰开发者真实的 ~/.photocull
      env: { ...process.env, NODE_ENV: 'test', PHOTOCULL_NO_OPEN: '1' },
    });

    let out = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // out 一律在这里取最新值，不用判定"起来了"那一刻的快照：
      // 横幅可能分几个 chunk 到齐，快照会截掉后半截。
      // child 带出去，好让用例能证明"resolve 时它真的已经没了"这条机制本身。
      resolve({ ...result, out, child });
    };

    // claimed 非 null = 我们已经看到它起来了、正在杀它；等它退完就用这个结果。
    //
    // 为什么是一个标志位而不是"再注册一个 exit 监听器"：EventEmitter 按注册顺序
    // 触发，而下面那个 exit 监听器在 spawn 之后立刻就挂上了，任何后挂的都排在它
    // 后面。后挂的监听器永远抢不到，结果会被定死成 started:false —— 症状是
    // 一个明明起来了的服务端被报成没起来，且 code 为 null（"被信号杀掉的"，
    // 正好说明它当时活着）。**这个文件就这么错过一版**，两条用例全红。
    let claimed = null;

    // 判定"起来了"之后必须**等子进程真的退出**再 resolve。只 kill 不等的话，
    // 这个文件会把还活着的服务端泄漏给后面的测试文件——它占着 5183，
    // 而且它的 SIGTERM 处理器还要跑 closeAllSessions。测试之间靠
    // "应该已经退了"这种默契来互不干扰，正是那种偶发一次、
    // 之后十次都复现不出来的失败的来源。
    const stopThenFinish = (result) => {
      if (settled || claimed) return;
      claimed = result;
      if (child.exitCode !== null || child.signalCode !== null) return finish(result);
      try { child.kill('SIGTERM'); } catch { finish(result); }
      // 兜底：SIGTERM 没能让它退出时别把整份用例挂死
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经没了 */ } }, 2000).unref?.();
    };

    const timer = setTimeout(() => stopThenFinish({ started: true }), 4000);

    child.stdout.on('data', (b) => {
      out += String(b);
      // 横幅一出来就说明 listen 成功了，不必干等满 4 秒
      if (out.includes('http://')) stopThenFinish({ started: true });
    });
    child.stderr.on('data', (b) => { out += String(b); });
    // 唯一的 exit 监听器。claimed 为空才说明是它自己先退的 = 没起来。
    child.on('exit', (code) => finish(claimed ?? { started: false, code }));
    child.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

describe('自启动守卫（node server/index.js 真的能起来）', () => {
  it('直接运行时会监听并打印地址', async () => {
    const { started, code, out } = await bootServer();
    // 修复前这里是 started=false / code=0 / out=''：静默退出，无从察觉
    expect({ started, code }).toEqual({ started: true, code: undefined });
    expect(out).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
  }, 20000);

  it('--share 时横幅给出局域网可见性告警', async () => {
    const { started, out } = await bootServer(['--share']);
    expect(started).toBe(true);
    // 具体措辞归 Task 13 的用例管，这里只钉住"确实换了一套说法"这个事实
    expect(out).not.toMatch(/只监听本机/);
  }, 20000);

  it('判定起来了之后不会把还活着的服务端泄漏给后面的测试文件', async () => {
    // 这条守的是 bootServer 自己的机制，不是 index.js：await 一返回，
    // 子进程必须**已经退干净**——否则它还占着 5183，后面的测试文件会莫名其妙
    // 撞端口，而且只是偶发。exitCode/signalCode 有一个非 null 就说明它没了。
    const { started, child } = await bootServer();
    expect(started).toBe(true);
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
  }, 20000);

  it('守卫的判定式对含非 ASCII 字符的路径成立', () => {
    // 这条是上面两条的单元级对照：不启动进程，直接比较两种写法。
    // 它跑得快、失败信息直指原因，而上面两条证明的是端到端真的能起来。
    const p = '/tmp/选 图/server/index.js';
    expect(`file://${p}`).not.toBe(pathToFileURL(p).href);   // 旧写法：不相等 -> 永不启动
    expect(pathToFileURL(p).href).toBe(pathToFileURL(p).href); // 新写法：恒成立
  });
});
