import type { DB, Settings } from '../db/index.ts';

/** True when `now` falls inside the configured business hours (in the configured time zone). */
export function withinBusinessHours(s: Settings, now: Date): boolean {
  if (!s.business_hours.enabled) return true;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: s.business_hours.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(now);
  return hm >= s.business_hours.start && hm < s.business_hours.end;
}

const ACTIVE = "status IN ('scheduled','sending','sent')";

/** Returns why a new reply in this group would break a rate limit, or null if it may go. */
export function rateLimitProblem(db: DB, s: Settings, groupId: number, now: Date): string | null {
  const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const { per_group_seconds, per_group_hour, global_hour } = s.rate_limits;
  const count = (sql: string, ...args: (string | number)[]) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM replies WHERE ${ACTIVE} AND ${sql}`).get(...args) as { n: number }).n;

  if (per_group_seconds > 0 && count('group_id = ? AND created_at > ?', groupId, since(per_group_seconds * 1000)) > 0)
    return `Rate limit: 1 reply per ${per_group_seconds} s in this group`;
  if (count('group_id = ? AND created_at > ?', groupId, since(3_600_000)) >= per_group_hour)
    return `Rate limit: ${per_group_hour} replies per hour in this group`;
  if (count('created_at > ?', since(3_600_000)) >= global_hour)
    return `Rate limit: ${global_hour} replies per hour across all groups`;
  return null;
}

/** Same sender, same group, same words within the window: answered already. */
export function isDuplicate(db: DB, s: Settings, groupId: number, sender: string, text: string, now: Date, excludeId: number): boolean {
  const since = new Date(now.getTime() - s.duplicate_window_minutes * 60_000).toISOString();
  const norm = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const rows = db.prepare(`SELECT text FROM messages WHERE group_id = ? AND sender = ? AND received_at > ? AND id <> ?
      AND outcome IN ('quoted','booking','held')`).all(groupId, sender, since, excludeId) as { text: string }[];
  return rows.some((r) => r.text.trim().toLowerCase().replace(/\s+/g, ' ') === norm);
}
