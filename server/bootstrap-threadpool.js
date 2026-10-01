// 必须是 server/index.js 的第一个静态 import——只有这样才能保证这行赋值真的抢在
// libuv 创建它自己的线程池之前执行。ESM 的求值顺序是：一个模块的所有 import
// （以及它们的传递依赖）都会先被完整求值，然后才轮到这个模块自己的顶层代码；
// 换句话说，把这行代码原样抄到 index.js 顶部、写在其他 import 语句"之前"，
// 实际执行顺序反而更晚——因为 index.js 自己的顶层代码本来就排在它所有 import
// 之后。真正决定"谁先执行"的是这个模块在 import 图里排第几个被引入，而不是这行
// 赋值语句在源码里写在哪一行。
//
// 这个文件本身除了下面这两行之外不能有其他 import——哪怕是 Node 内置模块——
// 否则那些依赖会先于这行赋值被求值，一旦某个依赖自己在模块加载期间就摸了一下
// 线程池（哪怕只是无意的），这次覆盖就又晚了。
//
// 背景（详见 .superpowers/sdd/2026-07-26-photocull/task-7-report.md「Fix round 1
// · F3」「Fix round 2 · F3b」）：Node 的 libuv 线程池默认只有 4 个线程，sharp 的
// 每次 resize/encode 调用都是作为一个任务丢进这个池子执行的；server/lib/thumbs.js
// 里的并发闸门（p-limit，宽度 = 核数-1）如果配的是默认线程池，闸门放行的并发数
// 大于 4 时，多出来的请求会在 libuv 内部再排一次队——闸门本身形同虚设。
//
// import node:os 本身是安全的：它只是同步的系统调用绑定（cpus()/homedir() 等），
// 不会去摸 libuv 的异步线程池，所以不会造成"线程池已经被别的模块提前创建"的问题。
import os from 'node:os';

// 下限是 4 而不是 1：这个池子是**全局**的，除了 sharp 还服务 walk 的每文件 stat、
// exifr 读取和 export 的 copyFile。写成 max(1, cpus-1) 时，一台 2 核机器会把它缩到
// 1——比 Node 自己的默认值 4 还小，扫描、元数据、导出全都跟着变慢，而这恰恰是最
// 承受不起变慢的那类机器。
process.env.UV_THREADPOOL_SIZE = String(Math.max(4, os.cpus().length - 1));
