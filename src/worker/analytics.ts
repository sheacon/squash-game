import type { Env } from "./room";

export type GameEvent = "visit" | "join" | "match";

// Single Analytics Engine dataset with a uniform column layout so a given
// dimension lives in the same slot for every event type and the /stats queries
// stay simple:
//   blob1 = event   blob2 = country   blob3 = role   blob4 = room
//   index1 = event  (the sampling key)
// Counting is done with SUM(_sample_interval) at query time, which stays
// accurate if Cloudflare ever samples; double1 is just a per-row 1 for clarity.
export function track(
  env: Env,
  event: GameEvent,
  opts: { country?: string; role?: string; room?: string } = {},
): void {
  if (!env.ANALYTICS) return; // binding absent (e.g. older config) — no-op
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [event, opts.country ?? "", opts.role ?? "", opts.room ?? ""],
      doubles: [1],
      indexes: [event],
    });
  } catch {}
}

// request.cf is present at runtime in production; absent under `wrangler dev`.
export function countryOf(request: Request): string | undefined {
  return (request.cf as { country?: string } | undefined)?.country;
}
