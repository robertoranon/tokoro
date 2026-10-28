// Conflict reconcile after a write (worker/SPECS.md section 7). Kept apart
// from conflicts.ts so the handlers in index.ts and admin-conflicts.ts share
// it without an import cycle, and calls go through the module boundary.
import type { Env } from './index';
import { reevaluateConflicts } from './conflicts';
import { notifyConflict } from './alerts';

/**
 * Re-check the conflict state of each (act_url, day) pair touched by a write
 * and notify on a newly created conflict. A notification failure is logged and
 * never fails the write; neither does a reevaluation failure (logged, and the
 * other pairs still run). Pairs without an act_url are skipped.
 */
export async function reevaluateAfterWrite(
  env: Env,
  pairs: { actUrl: string | null | undefined; startTime: string | null }[]
): Promise<void> {
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!p.actUrl || !p.startTime) continue;
    const day = p.startTime.slice(0, 10);
    const key = `${p.actUrl.replace(/\/+$/, '')}|${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The write has already committed: a failure here is logged, never a 500.
    // The next write touching this band-day corrects its conflict state.
    let created;
    try {
      ({ created } = await reevaluateConflicts(env, p.actUrl, day));
    } catch (err) {
      console.error(
        `reevaluateConflicts failed for ${p.actUrl} on ${day}:`,
        err
      );
      continue;
    }
    if (created) {
      try {
        await notifyConflict(env, created);
      } catch (err) {
        console.error('notifyConflict failed:', err);
      }
    }
  }
}
