import { describe, it, expect } from 'vitest';
import { evaluate, setContribution, backfill, visibleMark, sanitizeContrib } from './contrib.js';

describe('evaluate', () => {
  it('at 最大的那条赢', () => {
    expect(evaluate({
      u_ab: { mark: 'pick', at: 1234 },
      admin: { mark: 'reject', at: 1240 },
    })).toEqual({ by: 'admin', mark: 'reject', at: 1240 });

    // 插入顺序**故意**反过来：上面那组里 at 大的恰好也是后插入的，于是
    // 「取最后插入的那条、根本不看 at」这种实现给出的答案和正确实现一模一样，
    // 只有上面那条断言的话，这个用例挂着「at 最大的赢」的名字却验不了它。
    // 这里让 at 大的排在前面，取最后插入的实现就会答错。
    expect(evaluate({
      admin: { mark: 'reject', at: 1240 },
      u_ab: { mark: 'pick', at: 1234 },
    })).toEqual({ by: 'admin', mark: 'reject', at: 1240 });
  });

  it('只有一个人时就是他', () => {
    expect(evaluate({ u_ab: { mark: 'pick', at: 1 } })).toEqual({ by: 'u_ab', mark: 'pick', at: 1 });
  });

  it('空表或缺失返回 null', () => {
    expect(evaluate({})).toBeNull();
    expect(evaluate(undefined)).toBeNull();
    expect(evaluate(null)).toBeNull();
  });

  it('at 相同时按 userId 字典序取大的，保证结果确定', () => {
    // 同一毫秒内两个人各写一次是可能的。没有这条平局规则，
    // 同一份 contrib 在不同的 Object.entries 顺序下会求出两个不同的答案。
    const entry = { u_aa: { mark: 'pick', at: 5 }, u_bb: { mark: 'reject', at: 5 } };
    expect(evaluate(entry).by).toBe('u_bb');
    expect(evaluate({ u_bb: entry.u_bb, u_aa: entry.u_aa }).by).toBe('u_bb');
  });
});

describe('setContribution', () => {
  it('写入一票', () => {
    expect(setContribution(undefined, 'u_ab', 'pick', 100))
      .toEqual({ u_ab: { mark: 'pick', at: 100 } });
  });

  it('同一个人再写一次是覆盖，不是追加', () => {
    // 每人每张只留最后一次。留完整历史对「她收藏了哪些」毫无帮助，
    // 只会让文件随着选片时长无限增长。
    const entry = setContribution({ u_ab: { mark: 'pick', at: 100 } }, 'u_ab', 'reject', 200);
    expect(entry).toEqual({ u_ab: { mark: 'reject', at: 200 } });
  });

  it('取消标记是删掉这个人的条目', () => {
    const entry = setContribution(
      { u_ab: { mark: 'pick', at: 100 }, admin: { mark: 'pick', at: 50 } },
      'u_ab', null, 200,
    );
    expect(entry).toEqual({ admin: { mark: 'pick', at: 50 } });
  });

  it('最后一个人也取消之后整条返回 null', () => {
    expect(setContribution({ u_ab: { mark: 'pick', at: 100 } }, 'u_ab', null, 200)).toBeNull();
  });

  it('不修改传进来的那个对象', () => {
    const entry = { u_ab: { mark: 'pick', at: 100 } };
    setContribution(entry, 'admin', 'reject', 200);
    expect(entry).toEqual({ u_ab: { mark: 'pick', at: 100 } });
  });

  it('取消之后有效标记回退到上一个人那一票', () => {
    // 这是整套设计里唯一改变现有行为的地方，也是它存在的理由：
    // 现在新娘把摄影师收藏的一张改成排除、再自己取消，摄影师那一票就永久消失了。
    let entry = setContribution(undefined, 'admin', 'pick', 100);
    entry = setContribution(entry, 'u_ab', 'reject', 200);
    expect(evaluate(entry).mark).toBe('reject');

    entry = setContribution(entry, 'u_ab', null, 300);
    expect(evaluate(entry)).toEqual({ by: 'admin', mark: 'pick', at: 100 });
  });
});

describe('backfill', () => {
  it('有归属的按归属回填', () => {
    expect(backfill({ a: 'pick' }, { a: { by: 'u_ab', at: 777 } }))
      .toEqual({ a: { u_ab: { mark: 'pick', at: 777 } } });
  });

  it('没归属的算 admin，时间戳用 0', () => {
    // 那些文件夹是单机选的，标记本来就是摄影师自己按的。
    // at = 0 让任何后来的改动都赢过它，这正是我们想要的。
    expect(backfill({ a: 'pick' }, {})).toEqual({ a: { admin: { mark: 'pick', at: 0 } } });
    expect(backfill({ a: 'reject' }, undefined)).toEqual({ a: { admin: { mark: 'reject', at: 0 } } });
  });

  it('归属字段坏掉时退化成 admin，不抛', () => {
    expect(backfill({ a: 'pick' }, { a: { by: '', at: 'x' } }))
      .toEqual({ a: { admin: { mark: 'pick', at: 0 } } });
  });

  it('没有标记就没有贡献', () => {
    expect(backfill({}, {})).toEqual({});
  });
});

describe('visibleMark', () => {
  const entry = { u_ab: { mark: 'pick', at: 1 }, u_cd: { mark: 'reject', at: 9 }, admin: { mark: 'reject', at: 2 } };

  it('自己的优先于摄影师的', () => {
    // 她改过的那一张，界面上要显示成她改过的样子。
    expect(visibleMark(entry, 'u_ab')).toBe('pick');
  });

  it('自己没碰过时看摄影师的', () => {
    expect(visibleMark(entry, 'u_zz')).toBe('reject');
  });

  it('别的客户那一票一律看不见', () => {
    // u_cd 的 at 最大（有效标记是他的 reject），但对 u_ab 来说不存在。
    expect(visibleMark({ u_cd: { mark: 'pick', at: 9 } }, 'u_ab')).toBeNull();
  });

  it('空表返回 null', () => {
    expect(visibleMark(undefined, 'u_ab')).toBeNull();
    expect(visibleMark({}, 'u_ab')).toBeNull();
  });
});

describe('sanitizeContrib', () => {
  it('放行形状完整的条目', () => {
    const clean = sanitizeContrib({ a: { u_ab: { mark: 'pick', at: 1 } } });
    expect(clean).toEqual({ a: { u_ab: { mark: 'pick', at: 1 } } });
  });

  it('非法标记值、非数字时间戳、空 userId 一律丢弃', () => {
    expect(sanitizeContrib({
      a: { u_ab: { mark: 'maybe', at: 1 } },
      b: { u_ab: { mark: 'pick', at: 'x' } },
      c: { '': { mark: 'pick', at: 1 } },
    })).toEqual({});
  });

  it('字段坏成任何别的形状都退化成空表，不抛', () => {
    // 升级不该让摄影师昨天的选片打不开。
    expect(sanitizeContrib(undefined)).toEqual({});
    expect(sanitizeContrib(null)).toEqual({});
    expect(sanitizeContrib([1, 2, 3])).toEqual({});
    expect(sanitizeContrib('随便什么')).toEqual({});
    expect(sanitizeContrib({ a: 'not-an-object' })).toEqual({});
  });

  it('一张照片里只有部分条目坏掉时，保留好的那些', () => {
    expect(sanitizeContrib({
      a: { u_ok: { mark: 'pick', at: 1 }, u_bad: { mark: 'nope', at: 2 } },
    })).toEqual({ a: { u_ok: { mark: 'pick', at: 1 } } });
  });
});
