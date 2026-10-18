// [v26→27 回归] 语音转录碎片不该进决策库。
//
// 病历（2026-10-18，agent1super 库 666 条决策逐条过）：
//   10 条是语音输入被抽成决策，形状都是「决策动词开头 + 60~82 字口水」：
//     「选择l l a m a点c p p android然后呢这个engine这个东西呃为什么我看日志都没有在跳啊」
//     「换成更柔一点的更美术一点点的字体还有就是呃标题其实不一定是爵士与蓝调因为…」
//   另有 6 条是「选择/决定 + 状态词」的伪决策：
//     「选择都还可以」「选择页出来了」「选择每次都被验证是对的」「选择仍有地雷」
//     「选择都清楚了」「决定还是等你」
//   占比 16/666 = 2.4%，逐条读过，**零误杀**。
//
// 为什么只认「呃/嗯」不认「啊/那个」：
//   实测把「啊/那个」也算进去会误杀 2 条真决策 ——
//     「放弃一开始说的那个extraord的插件那个插件我基本上准备停用了」（真决策，2 个「那个」）
//     「换成com那个协议试试会不会就可以调节思考我就是要拉满啊」（真意图，「那个」「啊」各 1）
//   而「呃」「嗯」是语音识别的填充音，写下来的技术结论里几乎不会自然出现。
import { describe, it, expect } from 'vitest';
import { extractDecisions } from '../../src/core/extract/extract.js';
import type { Msg } from '../../src/core/extract/extract.js';

const m = (content: string): Msg => ({ role: 'user', content, seqNum: 1, createdAt: '2026-10-18T00:00:00Z' });
const one = (s: string) => extractDecisions([m(s)]).map((d) => d.text);

describe('[v26→27] 语音碎片与伪决策守卫', () => {
  it('① 含「呃/嗯」的语音转录碎片不再入库', () => {
    expect(one('选择l l a m a点c p p android然后呢这个engine这个东西呃为什么我看日志都没有在跳啊就之前还会在跳现在怎么都不跳')).toEqual([]);
    expect(one('决定呃你怎么说哪个给就是哪一些拉满不拉满什么的然后你有没有查清楚的每个模型真实的能力是什么样的')).toEqual([]);
    expect(one('换成新面板，然后把记一台那边的呃那个面板bug处理好')).toEqual([]);
    expect(one('选择用mimo-v2.6-flash-free嗯然后用这个批量生成这个训练机的')).toEqual([]);
  });

  it('② 单字口吃（纯中文连续 4 次以上）不再入库', () => {
    expect(one('决定就就就就换这个方案吧')).toEqual([]);
  });

  it('③ 「选择/决定 + 状态词」的伪决策不再入库', () => {
    expect(one('选择都还可以')).toEqual([]);
    expect(one('选择界面还没有被唤起')).toEqual([]);
    expect(one('选择每次都被验证是对的')).toEqual([]);
    expect(one('选择都清楚了')).toEqual([]);
    expect(one('选择仍有地雷')).toEqual([]);
    expect(one('决定还是等你')).toEqual([]);
  });

  it('④ 真决策必须留下（短句、含「那个/啊」、含代码与长数字）', () => {
    // 短但完整
    expect(one('升级到 v2')).toHaveLength(1);
    expect(one('弃用回普通话')).toHaveLength(1);
    // 含「那个/啊」但是真结论 —— 这是 v26 特意不收「啊/那个」的原因
    expect(one('放弃一开始说的那个extraord的插件那个插件我基本上准备停用了')).toHaveLength(1);
    expect(one('换成com那个协议试试会不会就可以调节思考我就是要拉满啊')).toHaveLength(1);
    // 代码/路径/长数字里出现的重复字符不是口吃（不写反引号：既有判据会先拦掉带反引号的）
    expect(one('改为 C:\\Program Files\\nodejs\\node.exe，与 watch-task.cmd 同源')).toHaveLength(1);
    expect(one('改为像素面积，即 w*h > 1_200_000 才缩，长边仍限 1280')).toHaveLength(1);
  });
});