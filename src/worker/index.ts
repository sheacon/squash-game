import { GameRoom, type Env } from "./room";
import { countryOf, track } from "./analytics";
import { renderStats } from "./stats";

export { GameRoom };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/ws\/([A-Z2-9]{4,8})$/);
    if (match) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const id = env.ROOM.idFromName(match[1]);
      return env.ROOM.get(id).fetch(request);
    }
    if (url.pathname === "/stats") {
      return renderStats(request, env);
    }
    // Count the landing-page document load (one per visit). This branch only
    // runs because assets.run_worker_first = ["/"] routes "/" through the
    // Worker first; every other asset (js/css/images) is served by the binding
    // before the Worker is ever invoked.
    if (url.pathname === "/") {
      track(env, "visit", { country: countryOf(request) });
    }
    // Proxy to the asset binding ourselves. For "/" this is required (the
    // Worker ran first); for any non-asset path it serves the binding's 404.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
