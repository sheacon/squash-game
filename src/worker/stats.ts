import type { Env } from "./room";

// Server-rendered usage dashboard at /stats, backed by the Analytics Engine SQL
// API. Gated by ?key=<STATS_KEY> when that secret is set. Account id and API
// token (scope: Account Analytics Read) come from secrets, so nothing sensitive
// ships in the bundle or the public repo.
export async function renderStats(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.STATS_KEY && url.searchParams.get("key") !== env.STATS_KEY) {
    return new Response("not found", { status: 404 });
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return html(
      `<h1>stats not configured</h1><p>Set <code>CF_ACCOUNT_ID</code> and ` +
        `<code>CF_API_TOKEN</code> (Account Analytics Read) as worker secrets.</p>`,
      503,
    );
  }

  const D = "squash_events";
  try {
    const [totals, byRole, daily, countries] = await Promise.all([
      sql(env, `SELECT blob1 AS event, SUM(_sample_interval) AS n FROM ${D} WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY event`),
      sql(env, `SELECT blob3 AS role, SUM(_sample_interval) AS n FROM ${D} WHERE blob1 = 'join' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY role`),
      sql(env, `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, SUM(_sample_interval) AS n FROM ${D} WHERE blob1 = 'visit' AND timestamp > NOW() - INTERVAL '14' DAY GROUP BY day ORDER BY day`),
      sql(env, `SELECT blob2 AS country, SUM(_sample_interval) AS n FROM ${D} WHERE blob1 = 'visit' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY country ORDER BY n DESC LIMIT 12`),
    ]);

    const total = (event: string) => num(totals.find((r) => r.event === event)?.n);
    const visits = total("visit");
    const matches = total("match");
    const hosts = num(byRole.find((r) => r.role === "host")?.n);
    const guests = num(byRole.find((r) => r.role === "guest")?.n);

    return html(`
      <h1>SQUASH · usage <span class="sub">last 30 days</span></h1>
      <div class="cards">
        ${card(visits, "page visits")}
        ${card(hosts, "games hosted")}
        ${card(guests, "guests joined")}
        ${card(matches, "2-player matches")}
      </div>
      <h2>visits per day <span class="sub">last 14 days</span></h2>
      ${barChart(daily)}
      <h2>top countries <span class="sub">visits, 30 days</span></h2>
      ${countryTable(countries)}
      <p class="foot">data via Cloudflare Analytics Engine · ~90-day retention · refresh to update</p>
    `);
  } catch (err) {
    return html(`<h1>stats error</h1><pre>${esc(String(err))}</pre>`, 502);
  }
}

async function sql(env: Env, query: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: query },
  );
  if (!res.ok) throw new Error(`SQL API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return json.data ?? [];
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function card(value: number, label: string): string {
  return `<div class="card"><div class="num">${value.toLocaleString("en-US")}</div><div class="lbl">${label}</div></div>`;
}

function barChart(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return `<p class="empty">no visits yet</p>`;
  const max = Math.max(1, ...rows.map((r) => num(r.n)));
  const bars = rows
    .map((r) => {
      const n = num(r.n);
      const day = String(r.day ?? "").slice(5, 10); // MM-DD
      const pct = Math.max(2, Math.round((n / max) * 100));
      return `<div class="bar"><span class="bn">${n}</span><span class="bf" style="height:${pct}%"></span><span class="bd">${day}</span></div>`;
    })
    .join("");
  return `<div class="chart">${bars}</div>`;
}

function countryTable(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return `<p class="empty">no data yet</p>`;
  const body = rows
    .map((r) => `<tr><td>${esc(String(r.country || "??"))}</td><td class="r">${num(r.n).toLocaleString("en-US")}</td></tr>`)
    .join("");
  return `<table>${body}</table>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function html(body: string, status = 200): Response {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>SQUASH · usage</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px 20px 48px; background: #0d0f12; color: #e8eaed;
    font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 760px; margin-inline: auto; }
  h1 { font-size: 20px; letter-spacing: .12em; }
  h2 { font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: #9aa0a6; margin-top: 34px; }
  .sub { color: #5f6368; font-weight: 400; letter-spacing: 0; text-transform: none; font-size: 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .card { background: #16191d; border: 1px solid #23272d; border-radius: 12px; padding: 16px; }
  .num { font-size: 30px; font-weight: 700; color: #f5c542; }
  .lbl { color: #9aa0a6; font-size: 12px; margin-top: 4px; }
  .chart { display: flex; align-items: flex-end; gap: 6px; height: 160px; border-bottom: 1px solid #23272d; padding-top: 18px; }
  .bar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
  .bf { width: 100%; max-width: 34px; background: linear-gradient(#f5c542, #c79a1f); border-radius: 4px 4px 0 0; }
  .bn { font-size: 11px; color: #9aa0a6; }
  .bd { font-size: 10px; color: #5f6368; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 8px; border-bottom: 1px solid #1b1e22; }
  td.r { text-align: right; color: #f5c542; }
  .empty, .foot { color: #5f6368; font-size: 12px; }
  .foot { margin-top: 40px; }
  pre { white-space: pre-wrap; color: #ff8a80; }
</style></head><body>${body}</body></html>`;
  return new Response(doc, { status, headers: { "content-type": "text/html;charset=utf-8" } });
}
