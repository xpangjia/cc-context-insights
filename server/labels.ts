/**
 * 会话的自定义名称和固定置顶。这是你手动设的,单独一张表,重建索引不会清掉。
 */
import { db } from "./db";
import { ensureSchema } from "./indexer";

ensureSchema(db);
export type Label = { name: string | null; pinnedAt: string | null };

export function labelsOf(ids?: string[]): Map<string, Label> {
  const rows = (ids ? db.query(`SELECT * FROM cc_labels WHERE session_id IN (${ids.map(() => "?").join(",") || "''"})`).all(...ids)
    : db.query("SELECT * FROM cc_labels").all()) as any[];
  return new Map(rows.map(r => [r.session_id, { name: r.name, pinnedAt: r.pinned_at }]));
}

/** name: 字符串 = 改名,空字符串 = 恢复原标题,不传 = 不动;pinned: true/false = 固定/取消,不传 = 不动 */
export function setLabel(id: string, patch: { name?: string; pinned?: boolean }): Label {
  const cur = labelsOf([id]).get(id) ?? { name: null, pinnedAt: null };
  const name = patch.name === undefined ? cur.name : patch.name.trim().slice(0, 120) || null;
  const pinnedAt = patch.pinned === undefined ? cur.pinnedAt : patch.pinned ? cur.pinnedAt ?? new Date().toISOString() : null;
  if (!name && !pinnedAt) db.query("DELETE FROM cc_labels WHERE session_id = ?").run(id);
  else db.query("INSERT INTO cc_labels (session_id, name, pinned_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, pinned_at = excluded.pinned_at").run(id, name, pinnedAt);
  return { name, pinnedAt };
}

/** 所有固定的会话,按固定时间先后 */
export function pinnedSessions() {
  return (db.query(`SELECT l.session_id id, l.name, l.pinned_at, s.title, s.last_at, s.cwd, s.dir FROM cc_labels l
    JOIN cc_sessions s ON s.id = l.session_id WHERE l.pinned_at IS NOT NULL ORDER BY l.pinned_at`).all() as any[]);
}
