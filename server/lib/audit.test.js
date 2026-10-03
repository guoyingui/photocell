import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newToken } from './tokens.js';
import { csvCell } from './csv.js';
import { logEvent, readEvents, eventsToCsv, eventsPath, ACTIONS } from './audit.js';

// 每个用例都把 PHOTOCULL_HOME 指向一次性临时目录，做法与 appdir.test.js 一致：
// 绝不能让测试碰到开发者真实的 ~/.photocull。
let home;
let savedEnv;
const shareId = 'sh_test1';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-audit-'));
  savedEnv = process.env.PHOTOCULL_HOME;
  process.env.PHOTOCULL_HOME = home;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

describe('logEvent 令牌脱敏', () => {
  it('令牌绝不会出现在日志文件里', async () => {
    const token = newToken();
    // 故意把令牌塞进多个位置：顶层、嵌套对象、数组
    await logEvent(
      shareId,
      {
        actor: 'admin',
        action: 'share.create',
        token,
        nested: { t: token },
        list: ['x', token],
      },
      [token],
    );
    const raw = await fs.readFile(eventsPath(shareId), 'utf8');
    expect(raw).not.toContain(token); // 子串搜索，不是字段检查
    expect(raw).toContain('[redacted]');
  });
});

describe('readEvents 容错', () => {
  it('一行坏 JSON 不影响其它行被读出来', async () => {
    await logEvent(shareId, { actor: 'admin', action: 'user.join' }, []);
    await fs.appendFile(eventsPath(shareId), '{被截断的半行' + String.fromCharCode(10), 'utf8');
    await logEvent(shareId, { actor: 'admin', action: 'mark.set' }, []);
    const events = await readEvents(shareId, {});
    expect(events.map((e) => e.action)).toEqual(['mark.set', 'user.join']); // 倒序
  });
});

describe('并发写入', () => {
  it('并发写入不交错、不丢行', async () => {
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        logEvent(shareId, { actor: 'admin', action: 'mark.set', assetId: 'a' + i }, [])),
    );
    const events = await readEvents(shareId, { limit: 1000 });
    expect(events).toHaveLength(200);
    expect(new Set(events.map((e) => e.assetId)).size).toBe(200);
  });
});

describe('追加写，从不改写', () => {
  it('写入新事件不会改动此前已经落盘的字节', async () => {
    await logEvent(shareId, { actor: 'admin', action: 'session.connect' }, []);
    const before = await fs.readFile(eventsPath(shareId), 'utf8');
    await logEvent(shareId, { actor: 'admin', action: 'session.disconnect' }, []);
    const after = await fs.readFile(eventsPath(shareId), 'utf8');
    // 新内容必须是纯追加：旧内容原封不动地是新内容的前缀。
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });
});

describe('轮转', () => {
  it('超过阈值时轮转，且不丢行', async () => {
    // 先写一条量出单行大致长度，再据此设一个"两三行就会超过"的小阈值。
    await logEvent(shareId, { actor: 'admin', action: 'mark.set', assetId: 'probe' }, []);
    const probeSize = (await fs.stat(eventsPath(shareId))).size;
    await fs.rm(eventsPath(shareId));
    const maxBytes = Math.floor(probeSize * 2.5);

    const total = 9;
    for (let i = 0; i < total; i++) {
      await logEvent(shareId, { actor: 'admin', action: 'mark.set', assetId: 'a' + i }, [], { maxBytes });
    }

    // 阈值这么小，写 9 条必然至少轮转过一次。
    await expect(fs.stat(eventsPath(shareId, 1))).resolves.toBeTruthy();

    const events = await readEvents(shareId, { limit: 1000 });
    expect(events).toHaveLength(total);
    expect(new Set(events.map((e) => e.assetId)).size).toBe(total);
  });

  it('只保留 3 代：连续轮转 5 次后第 4 代不存在', async () => {
    // maxBytes 定得极小，几乎任何一行内容都会让"下一次写入前的检查"判定超限，
    // 于是从第 2 次 logEvent 起，每次调用都会先触发一次轮转。
    const maxBytes = 1;
    const total = 6; // 第 1 次不轮转（文件还不存在），之后 5 次各轮转一次 = 连续轮转 5 次
    for (let i = 0; i < total; i++) {
      await logEvent(shareId, { actor: 'admin', action: 'mark.set', assetId: 'a' + i }, [], { maxBytes });
    }

    await expect(fs.stat(eventsPath(shareId, 4))).rejects.toThrow();

    // 当前文件 + 3 代都应该存在（都被写过东西）。
    for (const gen of [0, 1, 2, 3]) {
      await expect(fs.stat(eventsPath(shareId, gen))).resolves.toBeTruthy();
    }
  });
});

describe('过滤', () => {
  it('按 actor 和 action 过滤', async () => {
    await logEvent(shareId, { actor: 'admin', action: 'session.connect' }, []);
    await logEvent(shareId, { actor: 'u_1', action: 'mark.set', assetId: 'x' }, []);
    await logEvent(shareId, { actor: 'u_1', action: 'session.connect' }, []);
    await logEvent(shareId, { actor: 'u_2', action: 'mark.set', assetId: 'y' }, []);

    const byActor = await readEvents(shareId, { actor: 'u_1' });
    expect(byActor.map((e) => e.action).sort()).toEqual(['mark.set', 'session.connect']);

    const byAction = await readEvents(shareId, { action: 'mark.set' });
    expect(byAction.map((e) => e.actor).sort()).toEqual(['u_1', 'u_2']);

    const byBoth = await readEvents(shareId, { actor: 'u_1', action: 'mark.set' });
    expect(byBoth).toHaveLength(1);
    expect(byBoth[0].assetId).toBe('x');

    const byBothMiss = await readEvents(shareId, { actor: 'u_2', action: 'session.connect' });
    expect(byBothMiss).toHaveLength(0); // u_2 从没有 session.connect

    const byBothHit = await readEvents(shareId, { actor: 'u_2', action: 'mark.set' });
    expect(byBothHit).toHaveLength(1);
    expect(byBothHit[0].assetId).toBe('y');
  });

  it('limit 截断，before 只保留严格更早的事件', async () => {
    for (let i = 0; i < 5; i++) {
      await logEvent(shareId, { ts: 1000 + i, actor: 'admin', action: 'mark.set', assetId: 'a' + i }, []);
    }
    const limited = await readEvents(shareId, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((e) => e.assetId)).toEqual(['a4', 'a3']); // 倒序取最新两条

    const beforeCursor = await readEvents(shareId, { before: 1002 });
    expect(beforeCursor.map((e) => e.assetId)).toEqual(['a1', 'a0']);
  });
});

describe('ACTIONS', () => {
  it('是冻结的，且包含规格 3.4 的全部动作名', () => {
    expect(Object.isFrozen(ACTIONS)).toBe(true);
    expect(new Set(ACTIONS)).toEqual(
      new Set([
        'share.create', 'share.update', 'share.revoke',
        'user.join', 'user.resume', 'user.denied',
        'user.role-change', 'user.disable', 'user.enable', 'user.delete',
        'session.connect', 'session.disconnect',
        'mark.set', 'mark.bulk',
        'settings.update', 'export.run',
        'selection.submit', 'selection.confirm', 'selection.reopen', 'selection.final',
        'annotations.update', 'export.xmp',
      ]),
    );
  });

  /**
   * 删除用户是这一组管理操作里**唯一不可撤销**的那一个，所以它必须有自己的
   * 动作名，不能记成 `user.disable`。两者混成一件事之后，管理员事后再也分不清
   * "这个人只是被停用、随时能恢复"和"这个人连同他的令牌被彻底抹掉了"——
   * 而这恰恰是审计日志存在的意义。
   */
  it('user.delete 和 user.disable 是两个不同的动作名', () => {
    expect(ACTIONS).toContain('user.delete');
    expect(ACTIONS).toContain('user.disable');
    expect(ACTIONS.filter((a) => a === 'user.delete')).toHaveLength(1);
  });
});

describe('eventsToCsv', () => {
  it('CSV 里含逗号/引号/换行的字段被正确转义（复用 csv.js 的规则）', () => {
    const events = [
      { ts: 1785000000000, actor: 'u_1', nickname: 'a,b', action: 'user.join' },
      { ts: 1785000000001, actor: 'u_2', nickname: 'say "hi"', action: 'user.join' },
      { ts: 1785000000002, actor: 'u_3', nickname: 'line1\nline2', action: 'user.join' },
    ];
    const csv = eventsToCsv(events);
    expect(csv).toContain(csvCell('a,b'));
    expect(csv).toContain(csvCell('say "hi"'));
    expect(csv).toContain(csvCell('line1\nline2'));
  });

  it('payload 里的逗号和引号（JSON 序列化后）同样被正确转义', () => {
    const events = [
      { ts: 0, actor: 'admin', action: 'mark.set', assetId: 'cam-a/IMG_0421', from: null, to: 'pick' },
    ];
    const csv = eventsToCsv(events);
    const payloadJson = JSON.stringify({ assetId: 'cam-a/IMG_0421', from: null, to: 'pick' });
    expect(csv).toContain(csvCell(payloadJson));
  });

  it('header 行包含固定列名', () => {
    const csv = eventsToCsv([]);
    expect(csv.split('\r\n')[0]).toBe('ts,actor,nickname,action,payload');
  });
});

describe('shareId 校验', () => {
  it('拒绝可能构成路径穿越的 shareId', async () => {
    await expect(logEvent('../evil', { actor: 'admin', action: 'user.join' }, [])).rejects.toThrow();
    expect(() => eventsPath('../../etc')).toThrow();
  });
});
