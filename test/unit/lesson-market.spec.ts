// 跨项目经验市场（Task M）· 五条判据的钉子。
//
// 市场是**零模型**的：能推荐什么、排多前，全部由固定判据决定。
// 这五条测试分别钉住：① 同域优先 ② 跨域 / 本项目已有 降权 ③ 无重叠不上架
//   ④ 同输入两次结果逐字节相同 ⑤ 空输入不硬凑。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openGlobal, addLesson } from '../../src/store/global.js';
import {
  recommendLessons,
  AFFINITY_DOMAIN,
  AFFINITY_WORKSPACE,
  OWN_PROJECT_PENALTY,
} from '../../src/core/lessons/market.js';

const WS = 'D:\\proj\\alpha';
const DOMAIN = 'code';
/** 所有用例共用的一段正文：含 SQLite + 检索，保证话题能稳定命中 */
const HIT_TEXT = 'SQLite 检索要建 FTS 索引，否则大库查询会全表扫';

let gdb: ReturnType<typeof openGlobal>;
let seq = 0;

beforeEach(() => {
  gdb = openGlobal(':memory:');
  seq = 0;
});
afterEach(() => {
  try { gdb.close(); } catch { /* 已关闭 */ }
});

function put(o: {
  text: string;
  scope?: 'project' | 'domain' | 'global';
  workspaceId?: string;
  domain?: string;
  uses?: number;
  hits?: number;
}): number {
  const r = addLesson(gdb as never, {
    text: o.text,
    grade: 'verified-user',
    scope: o.scope ?? 'global',
    workspaceId: o.workspaceId,
    domain: o.domain,
    quote: '测试原句',
    sourceRef: 'test:' + (++seq),
    status: 'verified',
  } as never);
  if (o.uses || o.hits) {
    gdb.prepare('UPDATE lessons SET uses = ?, hits = ? WHERE id = ?')
      .run(o.uses ?? 0, o.hits ?? 0, r.id);
  }
  return r.id;
}

describe('跨项目经验市场', () => {
  it('同域命中：同领域经验排在跨领域前面，理由写明「同领域」', () => {
    const same = put({ text: HIT_TEXT, scope: 'domain', workspaceId: 'D:\\proj\\beta', domain: DOMAIN });
    const cross = put({ text: HIT_TEXT, scope: 'domain', workspaceId: 'D:\\proj\\gamma', domain: 'writing' });

    const first = recommendLessons(gdb, { workspaceId: WS, domain: DOMAIN, topics: ['SQLite', '检索'] });
    expect(first.map((x) => x.lesson.id)).toEqual([same, cross]);
    expect(first[0]!.score).toBeGreaterThan(first[1]!.score);
    expect(first[0]!.reason).toContain('同领域');
    expect(first[0]!.reason).toContain('命中');

    // ③ uses/hits 是权重：同域、同文本，被复用更多的那条排更前
    const hot = put({ text: HIT_TEXT, scope: 'domain', workspaceId: 'D:\\proj\\beta', domain: DOMAIN, uses: 4 });
    const again = recommendLessons(gdb, { workspaceId: WS, domain: DOMAIN, topics: ['SQLite', '检索'] });
    expect(again.map((x) => x.lesson.id)).toEqual([hot, same, cross]);
    expect(again[0]!.reason).toContain('复用');
  });

  it('跨域降权：跨领域低于同领域；本项目已有的再降一档', () => {
    const same = put({ text: HIT_TEXT, scope: 'domain', workspaceId: 'D:\\proj\\beta', domain: DOMAIN });
    const cross = put({ text: HIT_TEXT, scope: 'domain', workspaceId: 'D:\\proj\\beta', domain: 'writing' });
    const own = put({ text: HIT_TEXT, scope: 'project', workspaceId: WS });
    const globalOne = put({ text: HIT_TEXT, scope: 'global' });

    const r = recommendLessons(gdb, { workspaceId: WS, domain: DOMAIN, topics: ['SQLite', '检索'] });
    const byId = new Map(r.map((x) => [x.lesson.id, x]));
    expect(byId.size).toBe(4);

    // 其余条件相同 ⇒ 分数差恰好是权重差（round3 对于整偏移不改变差值）
    expect(byId.get(same)!.score - byId.get(cross)!.score).toBeCloseTo(AFFINITY_DOMAIN, 6);
    expect(byId.get(own)!.score - byId.get(globalOne)!.score)
      .toBeCloseTo(AFFINITY_WORKSPACE - OWN_PROJECT_PENALTY, 6);
    expect(byId.get(own)!.score).toBeLessThan(byId.get(globalOne)!.score);
    expect(byId.get(own)!.reason).toContain('降权');
  });

  it('无重叠不推荐：话题与经验没有可判据的重合 ⇒ 不上架（哪怕同领域）', () => {
    put({
      text: '写小说要先把人物弧线定下来，再安排章节节奏',
      scope: 'domain', workspaceId: 'D:\\proj\\beta', domain: DOMAIN,
    });
    expect(recommendLessons(gdb, { workspaceId: WS, domain: DOMAIN, topics: ['SQLite', '索引'] })).toEqual([]);
    // 只有常用词的话题同样不硬凑（gate2Score 的 pass 判据）
    expect(recommendLessons(gdb, { workspaceId: WS, domain: DOMAIN, topics: ['这个', '怎么'] })).toEqual([]);
  });

  it('确定性：同一输入两次调用逐字段相同（无随机、无时钟漂移）', () => {
    put({ text: HIT_TEXT, scope: 'domain', workspaceId: 'D:\\proj\\beta', domain: DOMAIN, uses: 2 });
    put({ text: 'SQLite 检索结果要按 bm25 排序，再按长度归一', scope: 'domain', workspaceId: WS, domain: DOMAIN });
    put({ text: 'SQLite 大表要先建索引，否则查询会扫全表', scope: 'global' });
    const opts = { workspaceId: WS, domain: DOMAIN, topics: ['SQLite', '检索'], limit: 3 };
    const a = recommendLessons(gdb, opts);
    const b = recommendLessons(gdb, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('空输入：无话题返回空；空库返回空；不因同领域就硬推', () => {
    put({ text: HIT_TEXT, scope: 'domain', workspaceId: 'D:\\proj\\beta', domain: DOMAIN });
    expect(recommendLessons(gdb, { workspaceId: WS, domain: DOMAIN, topics: [] })).toEqual([]);
    expect(recommendLessons(gdb, { workspaceId: WS, domain: DOMAIN, topics: ['   '] })).toEqual([]);

    const empty = openGlobal(':memory:');
    try {
      expect(recommendLessons(empty, { workspaceId: WS, domain: DOMAIN, topics: ['SQLite'] })).toEqual([]);
    } finally {
      empty.close();
    }
  });
});
