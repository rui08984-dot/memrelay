// 语音转录 / 口吃噪声判据 —— **唯一实现**。
//
// 为什么单独一个文件（10-18 实测）：决策抽取早就有了这两条（v27），而经验采集
//   （lesson-harvest.ts）走的是另一套关键词表，于是同一句语音碎片：
//     · 在决策侧被拒（含「呃」直接不收）；
//     · 在经验侧照样被收成草稿，再因 hits 升格 verified，最后注入每场会话的简报。
//   判据只许有一份 —— 所以把「像不像人说的话」抽出来，两条链路共用。
//
// 为什么只认「呃/嗯」不认「啊/那个」：实测 666 条决策里，把「啊/那个」也算进去会
//   误杀两条真决策（「放弃一开始说的那个extraord的插件那个插件我基本上准备停用了」、
//   「换成com那个协议试试会不会就可以调节思考我就是要拉满啊」）；而「呃」「嗯」是
//   语音识别产生的填充音，写下来的技术结论里几乎不会自然出现。

/** 纯中文同一字连续 4 次以上 = 口吃。先排除代码/路径/数字行，
 *  否则 `1_200_000`、`C:\\Program Files\\` 这类会被当成重复字符。
 *  也不做「两字词重复 3 次」：实测把「直接抓取源文件获取完整文件清单」里正常的
 *  「文件」重复判成了口吃。宁可少抓，不要冤枉真结论。 */
export function hasHanStutter(t: string): boolean {
  if (/[`\\]|https?:|\/|_|\d{4,}/.test(t)) return false; // 代码/路径/长数字：不判
  const han = t.replace(/[^\u4e00-\u9fa5]/g, '');
  let run = 1;
  for (let i = 1; i < han.length; i++) {
    if (han[i] === han[i - 1]) { run += 1; if (run >= 4) return true; } else run = 1;
  }
  return false;
}

/** 一句话像不像语音转录碎片（不进注入层的那类）。 */
export function looksLikeSpeechNoise(t: string): boolean {
  return /[呃嗯]/.test(t) || hasHanStutter(t);
}
