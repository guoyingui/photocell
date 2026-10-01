import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { lanAddresses } from './netaddr.js';

/**
 * 局域网地址探测。
 *
 * 这个模块只做一件事：把 `os.networkInterfaces()` 那一坨过滤成"发给客人的链接里
 * 可以写的地址"。两条过滤规则各自对应一种会让摄影师白忙一场的失败：
 *
 * - **回环地址**（127.0.0.1 / ::1）：写进链接发出去，客人打开的是他自己的电脑。
 *   这是最隐蔽的一种错——链接看起来完全正常，摄影师这边点开也确实能用。
 * - **IPv6 链路本地地址**（fe80::/10）：必须带 `%en0` 这样的作用域后缀才能用，
 *   而作用域是**接收方那台机器**上的网卡编号，不是发送方的。这种地址跨机器
 *   原理上就不可能工作，列出来只会让人挑中它然后连不上。
 *
 * 剩下的一律返回，**一个都不替人挑**（规格 8.1 / 计划 Task 18）。
 * 多网卡的机器上哪一个网段能通只有人知道：Wi-Fi、有线、虚拟机桥接、
 * VPN 的隧道口，服务端看到的信息完全一样。
 */

/** 一台典型的 macOS 笔记本：回环 + Wi-Fi + 一条有线，Wi-Fi 上还挂着链路本地。 */
const LAPTOP = {
  lo0: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true, scopeid: 0 },
    { address: 'fe80::1', family: 'IPv6', internal: true, scopeid: 1 },
  ],
  en0: [
    { address: 'fe80::14b:2f3a:9c1d:5e77', family: 'IPv6', internal: false, scopeid: 6 },
    { address: '192.168.1.23', family: 'IPv4', internal: false },
  ],
  en1: [
    { address: '10.0.0.5', family: 'IPv4', internal: false },
  ],
};

const addressesOf = (list) => list.map((e) => e.address);

describe('lanAddresses：过滤规则', () => {
  it('不返回回环地址，也不返回 IPv6 链路本地地址', () => {
    const got = addressesOf(lanAddresses(LAPTOP));
    expect(got).not.toContain('127.0.0.1');
    expect(got).not.toContain('::1');
    expect(got).not.toContain('fe80::1');
    expect(got).not.toContain('fe80::14b:2f3a:9c1d:5e77');
  });

  it('内网 IPv4 全部保留', () => {
    expect(addressesOf(lanAddresses(LAPTOP))).toEqual(['192.168.1.23', '10.0.0.5']);
  });

  it('链路本地的判定不区分大小写', () => {
    // Node 目前一律给小写，但这个判定是安全/可用性边界，不建立在"它一直会是小写"上。
    const got = addressesOf(lanAddresses({
      en0: [{ address: 'FE80::ABCD', family: 'IPv6', internal: false, scopeid: 6 }],
    }));
    expect(got).toEqual([]);
  });

  it('fe80 开头但不在 fe80::/10 里的地址不会被误杀', () => {
    // fec0:: 和 fe00:: 都不是链路本地。按字符串前缀 'fe8' 粗筛会漏，按 /10 判就不会。
    const got = addressesOf(lanAddresses({
      en0: [
        { address: 'fec0::1', family: 'IPv6', internal: false },
        { address: 'febf::1', family: 'IPv6', internal: false },  // fe80::/10 的最后一段，要被滤掉
      ],
    }));
    expect(got).toEqual(['fec0::1']);
  });

  it('internal 为 false 的回环网段地址同样滤掉', () => {
    // 双保险。internal 由操作系统给，虚拟网卡上见过它是 false 而地址却是 127 段的；
    // 只信 internal 的话这种地址会被写进发给客人的链接里。
    const got = addressesOf(lanAddresses({
      utun9: [
        { address: '127.0.0.2', family: 'IPv4', internal: false },
        { address: '::1', family: 'IPv6', internal: false },
      ],
    }));
    expect(got).toEqual([]);
  });

  it('可路由的 IPv6 保留', () => {
    const got = addressesOf(lanAddresses({
      en0: [
        { address: '2001:db8::42', family: 'IPv6', internal: false },
        { address: 'fd12:3456::7', family: 'IPv6', internal: false },   // 唯一本地地址，局域网里能用
      ],
    }));
    expect(got).toEqual(['2001:db8::42', 'fd12:3456::7']);
  });
});

describe('lanAddresses：返回的形状', () => {
  it('每一项都带 address / family / interface，供人自己挑', () => {
    expect(lanAddresses(LAPTOP)[0]).toEqual({
      address: '192.168.1.23', family: 'IPv4', interface: 'en0',
    });
  });

  it('family 由地址本身推导，不信 family 字段', () => {
    // 老版本 Node 给的是数字 4/6，新版本给字符串。地址里有没有冒号是唯一不会
    // 两说的信息源——两个来源打架时，前端拿着 family 去决定要不要给地址套方括号，
    // 猜错就拼出一个打不开的链接。
    const got = lanAddresses({
      en0: [
        { address: '192.168.1.9', family: 4, internal: false },
        { address: '2001:db8::9', family: 6, internal: false },
      ],
    });
    expect(got.map((e) => e.family)).toEqual(['IPv4', 'IPv6']);
  });
});

describe('lanAddresses：多网卡时不猜', () => {
  it('三块网卡上的地址一条不少地全部列出', () => {
    const got = lanAddresses({
      en0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
      en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
      bridge100: [{ address: '192.168.64.1', family: 'IPv4', internal: false }],
    });
    // 服务端分不出哪个网段客人连得上（Wi-Fi / 有线 / 虚拟机桥接看起来一模一样），
    // 所以这里绝不能"挑一个最像的"返回——那会让摄影师拿到一条打不开的链接，
    // 而且他没有任何线索知道该换哪一个。
    expect(addressesOf(got)).toEqual(['192.168.1.23', '10.0.0.5', '192.168.64.1']);
  });

  it('IPv4 排在 IPv6 前面，同族之间按网卡枚举顺序', () => {
    // 排序不是"替人挑"，只是把人更可能用得上的那些放在前面：
    // IPv4 短、能直接念给人听、不用套方括号。
    const got = lanAddresses({
      en0: [
        { address: '2001:db8::1', family: 'IPv6', internal: false },
        { address: '192.168.1.23', family: 'IPv4', internal: false },
      ],
      en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    });
    expect(addressesOf(got)).toEqual(['192.168.1.23', '10.0.0.5', '2001:db8::1']);
  });
});

describe('lanAddresses：坏输入不炸', () => {
  it.each([
    ['null', null],
    ['空对象', {}],
    ['网卡下是 null', { en0: null }],
    ['网卡下是空数组', { en0: [] }],
    ['条目缺 address', { en0: [{ family: 'IPv4', internal: false }] }],
    ['address 不是字符串', { en0: [{ address: 42, family: 'IPv4', internal: false }] }],
  ])('%s 时返回空数组而不是抛异常', (_name, input) => {
    expect(lanAddresses(input)).toEqual([]);
  });
});

describe('lanAddresses：不传参数时读真实网卡', () => {
  it('默认参数是 os.networkInterfaces()，且真实结果里没有回环地址', () => {
    // CI 上可能一块外网网卡都没有，所以只能断言"返回的每一条都合规"，
    // 不能断言"至少有一条"。真正把过滤规则钉死的是上面那些用夹具的用例。
    const got = lanAddresses();
    expect(Array.isArray(got)).toBe(true);
    for (const entry of got) {
      expect(entry.address).not.toBe('127.0.0.1');
      expect(entry.address).not.toBe('::1');
      expect(entry.address.toLowerCase().startsWith('fe8')).toBe(false);
    }
    // 同一台机器上，显式传入和默认参数必须给出同一份结果。
    expect(got).toEqual(lanAddresses(os.networkInterfaces()));
  });
});
