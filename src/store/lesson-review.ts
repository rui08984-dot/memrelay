// lesson-review.ts —— 人工复核经验草稿的**唯一实现**（CLI 与面板共用）。
//
// 为什么单独一个文件：这段逻辑原来内联在 cli/lesson.ts 里，面板要加审核按钮时
// 最容易的做法是复制一份 SQL —— 那样「CLI 确认了但面板没确认」或两边抬级规则不一致，
// 就会出现同一库两个答案。判据只许一份。
import type { DB } from './db.js';

export type ReviewAction = 'confirm' | 'reject';

export interface ReviewResult { updated: number; to: 'verified' | 'rejected'; }

/**
 * 人工复核：draft → verified / rejected。
 *
 * ⚠️ 只改状态是不够的：注入还有一道「等级」闸，inferred 一律进不去。
 *    **人工确认本身就是证据**（强于「文件里读到」），所以 confirm 时把 inferred 抬到
 *    verified-file（6.0）。实测踩过：只改状态 ⇒ 复核完还是 ○、还是进不了注入层，
 *    看起来「确认没生效」。
 */
export function reviewLessons(db: DB, ids: readonly number[], action: ReviewAction, now = new Date().toISOString()): ReviewResult {
  const to = action === 'confirm' ? 'verified' : 'rejected';
  const upd = db.prepare('UPDATE lessons SET status = ?, updated_at = ?, grade = CASE WHEN ? = ? AND grade = ? THEN ? ELSE grade END, importance = CASE WHEN ? = ? AND grade = ? THEN ? ELSE importance END WHERE id = ?');
  let updated = 0;
  for (const id of ids) {
    const r = upd.run(to, now, to, 'verified', 'inferred', 'verified-file', to, 'verified', 'inferred', 6.0, id);
    if (Number(r.changes) > 0) updated++;
  }
  return { updated, to };
}
