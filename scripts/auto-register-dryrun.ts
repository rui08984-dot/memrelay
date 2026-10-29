// auto-register-dryrun.ts —— 只读体检：守护现在会**自动接入**哪些新工作区？
//
// 用途：改了判据/怀疑漏收时，先看这份清单再决定要不要动注册表。
// 只读：dryRun=true，不 init、不写注册表。
// 用法：npx tsx scripts/auto-register-dryrun.ts
import { autoRegisterNewProjects } from '../src/capture/auto-register.js';

const r = autoRegisterNewProjects({ dryRun: true });
// created = 过了保守过滤、本轮**真正会建库**的目录（单轮上限 3）
console.log('会接入：' + r.created.length + ' 个');
for (const root of r.created) {
  const c = r.candidates.find((x) => x.root === root);
  console.log('  + ' + root + (c ? '（' + c.sessions + ' 个会话）' : ''));
}
console.log('跳过：' + r.skipped.length + ' 个');
const byReason = new Map<string, string[]>();
for (const s of r.skipped) {
  const key = s.reason.replace(/（.*$/, '');
  if (!byReason.has(key)) byReason.set(key, []);
  byReason.get(key)!.push(s.root);
}
for (const [reason, roots] of byReason) {
  console.log('  - ' + reason + '：' + roots.length + (roots.length <= 3 ? '（' + roots.join(' | ') + '）' : ''));
}