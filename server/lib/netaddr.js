import os from 'node:os';

/**
 * 局域网地址探测（分享面板用）。
 *
 * 唯一的职责：把 `os.networkInterfaces()` 过滤成"可以写进发给客人的链接里"的地址。
 * 纯函数，网卡表从参数进来，方便把各种网络环境写成夹具——真机上的网卡组合
 * 不可控，靠真实环境做断言的测试只能测到跑它的那台机器。
 *
 * 两条过滤规则，各自对应一种会让摄影师白忙一场的失败：
 *
 * - **回环地址**（127.0.0.0/8、::1）：写进链接发出去，客人打开的是他自己的电脑。
 *   这是最隐蔽的一种错——链接看起来完全正常，摄影师这边点开也确实能用，
 *   只有客人那边打不开，而他多半只会回一句"打不开"。
 * - **IPv6 链路本地地址**（fe80::/10）：要带 `%en0` 这样的作用域后缀才能用，
 *   而作用域是**接收方那台机器**上的网卡编号，不是发送方的。这种地址跨机器
 *   原理上就不可能工作，列出来只会让人挑中它然后连不上。
 *
 * 剩下的一律返回，**一个都不替人挑**（规格 8.1）。多网卡的机器上哪个网段客人
 * 连得上只有人知道：Wi-Fi、有线、虚拟机桥接、VPN 隧道口，在服务端看来
 * 是完全一样的一串数字。猜错的代价是摄影师拿到一条打不开的链接，
 * 而且没有任何线索知道该换哪一个。
 */

/** 只做展示分组，不参与判定——判定一律看地址本身。 */
const IPV4 = 'IPv4';
const IPV6 = 'IPv6';

/**
 * 地址族由**地址本身**推导，不读 `family` 字段。
 *
 * 老版本 Node 给数字 4/6，新版本给字符串 'IPv4'/'IPv6'，两种都在野外见得到。
 * 地址里有没有冒号是唯一不会两说的信息源，而前端要拿 family 决定要不要给地址
 * 套方括号（`http://[2001:db8::1]:5183`），猜错就拼出一个打不开的链接。
 */
function familyOf(address) {
  return address.includes(':') ? IPV6 : IPV4;
}

/** 去掉 IPv6 的作用域后缀（`fe80::1%en0`）。Node 一般不带，但别人塞进来的可能带。 */
function bare(address) {
  const cut = address.indexOf('%');
  return cut === -1 ? address : address.slice(0, cut);
}

function isLoopbackAddress(address) {
  const addr = bare(address).toLowerCase();
  // 整个 127.0.0.0/8，不只是 127.0.0.1：macOS 上给别名接口配 127.0.0.2 是常见做法。
  if (addr.startsWith('127.')) return true;
  return addr === '::1' || addr === '0:0:0:0:0:0:0:1';
}

/**
 * fe80::/10。**按前 10 位判，不按 'fe80' 这四个字符判**：
 * 这个前缀覆盖 fe80:: 一直到 febf:ffff:…，而 fec0::（早年的站点本地地址）
 * 不在里面。按字符串前缀粗筛会同时漏掉 fe90–febf 并可能误伤别的段。
 */
function isIpv6LinkLocal(address) {
  const first = bare(address).toLowerCase().split(':')[0];
  if (first === '') return false;      // '::1' 这类以 '::' 开头的地址，首段是空串
  const head = Number.parseInt(first, 16);
  if (!Number.isFinite(head)) return false;
  return (head & 0xffc0) === 0xfe80;
}

/**
 * 可以发给客人的局域网地址。
 *
 * @param {Record<string, Array<{address?: unknown, internal?: boolean}>|null|undefined>} [interfaces]
 *        网卡表，形状同 `os.networkInterfaces()`。不传时读真实网卡。
 * @returns {Array<{address: string, family: 'IPv4'|'IPv6', interface: string}>}
 *          IPv4 在前、IPv6 在后，同族内保持网卡枚举顺序。
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  if (interfaces === null || typeof interfaces !== 'object') return found;

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const address = entry?.address;
      if (typeof address !== 'string' || address === '') continue;

      // internal 由操作系统给，虚拟网卡上见过它对回环地址报 false。
      // 所以两个条件都查：任一成立就滤掉，宁可少列一个也不能把回环发出去。
      if (entry.internal === true) continue;
      if (isLoopbackAddress(address)) continue;

      const family = familyOf(address);
      if (family === IPV6 && isIpv6LinkLocal(address)) continue;

      found.push({ address: bare(address), family, interface: name });
    }
  }

  // 排序不是"替人挑"——全部候选都还在列表里，只是把人更可能用得上的放前面：
  // IPv4 短、能直接念给身边的人听、不用套方括号。Array#sort 是稳定的，
  // 所以同族之间保持网卡的枚举顺序，不会每次启动抖来抖去。
  return found.sort((a, b) => (a.family === b.family ? 0 : (a.family === IPV4 ? -1 : 1)));
}
