import { GameRoom, type Env } from "./room";

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
    // Everything else is a static asset. Proxy explicitly instead of relying
    // on platform fallthrough: wrangler dev (4.99/4.100) stops routing "/" to
    // assets when a custom_domain route is configured, and the binding serves
    // identically in production either way (including its own 404s).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
