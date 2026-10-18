// srelay note —— 把一条结论写进记忆库，**走真正的决策通道**
//
// 病历（2026-10-18）：DSH 插件的 srelay_remember 说「已记为已确认决策」，实际执行的是
// `srelay save --recent 1d --summary ...` —— 那是把最近一天的会话重新存一遍并附个摘要，
// 摘要落在会话的 summary 字段，**不进 decisions**。所以 remember 之后
// srelay decisions 查不到、pin 也匹配不到，但界面显示成功。写与读对不上。
//
// 这个命令复用 createNoteSession：写一场 source=note 的会话、立即 confirmed、
// 走正常抽取，笔记里的决策句式会进决策库。与 MCP 的 save_note 同一条路。
import { createNoteSession } from '../store/db.js';
import { projectIdOf } from '../shared/paths.js';
import { requireRoot, openRelayDb, die, pc } from './ui.js';

export interface NoteFlags {
  title?: string;
  content?: string;
  tag?: string;
  json?: boolean;
}

export async function cmdNote(f: NoteFlags): Promise<void> {
  const root = requireRoot();
  const title = String(f.title ?? '').trim();
  const content = String(f.content ?? '').trim();
  if (title.length < 2) die('--title 至少要 2 个字', '例：srelay note --title "选型结论" --content "改用 SQLite FTS5，不上向量库"');
  if (content.length < 4) die('--content 至少要 4 个字', '例：srelay note --title "选型结论" --content "改用 SQLite FTS5，不上向量库"');

  const tags = f.tag ? f.tag.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const db = openRelayDb(root);
  try {
    const id = createNoteSession(db, { projectId: projectIdOf(root), title, content, tags });
    if (f.json) {
      console.log(JSON.stringify({ ok: true, sessionId: id, source: 'note', state: 'confirmed', title, tags: tags ?? [] }));
      return;
    }
    console.log(pc.green('✓') + ' 已写入结论笔记（source=note，已确认并抽取）');
    console.log(pc.dim('  会话 ') + id);
    if (tags?.length) console.log(pc.dim('  标签 ') + tags.join(', '));
    console.log(pc.dim('  下一步：srelay decisions 应该能看到它；srelay pin "<片段>" 可以钉住'));
  } finally {
    db.close();
  }
}