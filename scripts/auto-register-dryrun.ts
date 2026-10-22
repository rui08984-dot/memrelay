// auto-register-dryrun.ts —— 只读体检：守护现在会**自动接入**哪些新工作区？
//
// 用途：改了判据/怀疑漏收时，先看这份清单再决定要不要动注册表。
// 只读：dryRun=true，不 init、不写注册表。
// 用法：npx tsx scripts/auto-register-dryrun.ts
import { autoRegisterNewProjects } from '../src/capture/auto-register.js';

const r = autoRegisterNewProjects({ dryRun: true });
console.log('候选（会接入）：' + r.candidates.length + ' 个');
for (const c of r.candidates) console.log('  + ' + c.root + '（' + c.sessions + ' 个会话）');
console.log('跳过：' + r.skipped.length + ' 个');
const byReason = new Map<string, number>();
for (const s of r.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
for (const [reason, n] of byReason) console.log('  - ' + reason + '：' + n);