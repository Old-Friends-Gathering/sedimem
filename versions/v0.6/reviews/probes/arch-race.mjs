// probe 3: 服务级「读-判-写」竞态：两个进程并发对同一 slot 写不同值
// storage/lock.js 只保护单次 append；service.write 的 decideWrite 读的是各自进程的内存快照。
import { createMemoryService } from '../../src/api/service.js';

const home = process.env.PROBE_HOME;
const value = process.env.PROBE_VALUE;
const svc = await createMemoryService({ memoHome: home, scope: 'repo:probe' });
const r = await svc.write({ text: `port is ${value}`, subject: 'server', predicate: 'port', value, source: { agent: 'test' } });
console.log(`value=${value} action=${r.action} id=${r.record.id}`);
await svc.close();
