// [10-18] 经验侧的噪音与「升格回撤」。
//
// 病历：库里的 id 25 是一条语音转录碎片，却因 hits=3 被自动升成 verified，
//   然后作为「跨项目经验」注入每场会话的简报（uses=50）。三条判据在这里钉死：
//   ① 语音碎片连**候选**都不收（与决策抽取共用 noise.ts 同一份判据）
//   ② 「要不要再」不再被「不要再」子串误命中（中文没有词边界，includes 必然误伤）
//   ③ maintainLessons 把「单出处却 verified」的自动升格回撤成 draft（只改状态、标 needs_review）
//
// 为什么这些必须写进测试：它们都是「修完不会再被想起」的判据 ——
//   今晚的教训是修了决策侧、漏了经验侧，而漏掉的那侧会静默污染每场会话。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGlobal, addLesson, maintainLessons } from '../../src/store/global.js';
import { harvestCandidates } from '../../src/core/extract/lesson-harvest.js';
import { looksLikeSpeechNoise } from '../../src/core/extract/noise.js';

const NOISE = '呃仓库名字叫什么呃写的呃就是一些简介啊还有就是完整的仓库一些说明啊还有包括....的呃都够不够用了就是要不要再描述一个详细一点或者怎么样的看一下调用我的最h';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-noise-'));
  process.env.SRELAY_GLOBAL_HOME = path.join(tmp, 'global');
});
afterEach(() => {
  delete process.env.SRELAY_GLOBAL_HOME;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

describe('经验候选 · 语音碎片不进库', () => {
  it('含「呃」的语音碎片不是候选（哪怕它含「不要再」）', () => {
    const out = harvestCandidates([{ role: 'user', content: NOISE, seqNum: 1, sessionId: 's1' }]);
    expect(out).toHaveLength(0);
  });

  it('「要不要再」不再被「不要再」子串误命中', () => {
    // 这句不含其它模式词，唯一可能命中就是 `不要再`（子串命中「要不要再」）
    const msg = '这个文档要不要再描述一个详细一点给读者看';
    expect(harvestCandidates([{ role: 'user', content: msg, seqNum: 1, sessionId: 's1' }])).toHaveLength(0);
  });

  it('真经验仍然抽得出来（对照组）', () => {
    const msg = '下次一定先把 vendor 重新生成，否则插件自测跑的是旧副本';
    const out = harvestCandidates([{ role: 'user', content: msg, seqNum: 1, sessionId: 's1' }]);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.level).toBe('verified-user');
  });

  it('共享判据（决策与经验同一份）：认「呃/嗯」与口吃，不误伤技术结论', () => {
    expect(looksLikeSpeechNoise('呃这个东西怎么弄')).toBe(true);
    expect(looksLikeSpeechNoise('嗯我觉得可以')).toBe(true);
    expect(looksLikeSpeechNoise('决定采用 SQLite FTS5，不上向量库')).toBe(false);
    expect(looksLikeSpeechNoise('改为 `C:\\Program Files\\nodejs\\node.exe`')).toBe(false);
  });
});

describe('经验维护 · 回撤「靠 hits 升上去」的自动升格', () => {
  it('单出处的 user-message verified ⇒ 退回 draft 并标 needs_review', () => {
    const gdb = openGlobal();
    const ins = addLesson(gdb as never, {
      text: '单出处的自动升格样本，应当被回撤成草稿',
      quote: '原句', sourceRef: 'a6095702661ffbc5:30076',
      route: 'user-message', grade: 'verified-user', scope: 'global', status: 'verified',
    } as never);

    const r = maintainLessons(gdb as never);
    expect(r.demotedPromotions).toBeGreaterThanOrEqual(1);
    const row = gdb.prepare('SELECT status, needs_review FROM lessons WHERE id = ?').get(ins.id) as
      { status?: string; needs_review?: number };
    expect(row.status).toBe('draft');
    expect(Number(row.needs_review)).toBe(1);
  });

  it('手工录入的 verified-user（route=none）不受回撤影响', () => {
    const gdb = openGlobal();
    const ins = addLesson(gdb as never, {
      text: '人明确录入的经验，不该被自动回撤',
      quote: '原句', sourceRef: 'manual:1',
      route: 'none', grade: 'verified-user', scope: 'global', status: 'verified',
    } as never);

    maintainLessons(gdb as never);
    const row = gdb.prepare('SELECT status FROM lessons WHERE id = ?').get(ins.id) as { status?: string };
    expect(row.status).toBe('verified');
  });
});
