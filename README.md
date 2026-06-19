# SQUASH — original arcade ROM, two phones

Play Gaelco's *Squash (Ver. 1.0)* (1992 arcade) against a friend over the internet.
One phone runs the real ROM in an in-browser emulator; the other phone receives the
live game over WebRTC and plays as Player 2. Text a link, both of you are on the
actual cabinet.

## How it works

- **Host** (whoever opens the site first) runs the game with
  [EmulatorJS](https://emulatorjs.org)'s FBNeo `arcade` core. EmulatorJS's built-in
  mobile touch controls drive Player 1.
- The emulator's canvas and audio are captured and streamed peer-to-peer (WebRTC) to
  the **guest**, who gets a touch overlay (8-way stick, two fire buttons, COIN and
  START). Guest inputs travel back on a data channel and are injected as Player 2 via
  the emulator's `simulateInput` API. The game itself is unmodified — the original
  supports 2 concurrent players.
- A Cloudflare Worker + Durable Object serves the site, brokers rooms
  (`https://…/#CODE`), and relays WebRTC signaling. Game traffic never touches the
  server.
- Players enter a name once per device. A presence strip near the controls shows
  who holds P1/P2 and how many people are waiting; joins and departures are
  announced on screen.
- Extra joiners (e.g. a link shared to a group text) queue up: they see who's
  playing and their position in line, can start their own room with one tap, and
  the first in line is auto-promoted to Player 2 if the guest seat stays empty for
  45 seconds. A waiter who reloads or backgrounds rejoins at the back of the line.
- **No ROM bundled.** Supply your own `squash.zip` (MAME/FBNeo romset `squash`) in
  `public/`. It is gitignored. Without it, the host streams a test pattern so you can
  still verify connectivity end to end. The original is preserved on the Internet
  Archive ([Squash (Ver. 1.0)](https://archive.org/details/arcade_squash)) and
  catalogued on the [Arcade Database](https://adb.arcadeitalia.net/dettaglio_mame.php?game_name=squash)
  for reference; note it remains Gaelco's copyright and is not licensed for reuse.
- **No game art bundled** for the same reason. The intro card looks for
  `public/gameplay.png` (gitignored) and quietly hides the image if it is absent.
  Drop in your own screenshot or artwork if you want it.

## Setup

```sh
npm install
cp wrangler.example.jsonc wrangler.jsonc   # then set your own name/domain
# put your squash.zip in public/           (not committed)
npm run dev          # → http://localhost:8787
```

Open the URL in one window (host), copy the room link into a second window (guest).
Desktop guest keys: arrows = stick, Z/X = fire 1/2, C = coin, Enter = start.

## Tests

```sh
npm test                      # signaling relay test (needs wrangler dev running)
node scripts/e2e-test.mjs     # headless host+guest WebRTC pipeline (no ROM needed)
```

## Deploy

```sh
npx wrangler login
npm run deploy       # → https://<name>.<your-subdomain>.workers.dev (+ custom domain)
```

`wrangler.jsonc` is gitignored; copy it from `wrangler.example.jsonc` and set your
own `name` and (optionally) domain first. A custom domain comes from the `routes`
entry (`custom_domain: true`): Cloudflare creates the DNS record and certificate on
deploy. The workers.dev URL stays enabled so older shared links keep working;
rooms are keyed by code, not origin, so players on different hostnames can
share a room.

## Usage stats

A self-hosted dashboard at **`/stats`** (e.g. `https://<your-domain>/stats?key=…`)
shows page visits, games hosted, guests joined, 2-player matches, a 14-day visits
chart, and a country breakdown. It runs on
[Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/):
the worker writes one data point per visit/join/match (`src/worker/analytics.ts`)
and the dashboard reads them back through the SQL API (`src/worker/stats.ts`).
Game traffic stays P2P; only these coarse counters are recorded (event, country,
role, room code), no IPs or personal data. Free-tier writes and ~90-day retention
comfortably cover a launch.

The `ANALYTICS` binding is already in `wrangler.jsonc`; the dataset is created on
first write. Add three secrets so `/stats` can query and stay private:

```sh
wrangler secret put CF_ACCOUNT_ID    # your Cloudflare account id
wrangler secret put CF_API_TOKEN     # API token, scope: Account Analytics → Read
wrangler secret put STATS_KEY        # any passphrase; /stats requires ?key=<this>
npm run deploy
```

If `STATS_KEY` is unset the page is open; if the account id / token are unset it
returns a "not configured" notice instead of data. Under `wrangler dev` no data
points are recorded (the local binding is a no-op).

## Known tuning points

- `src/client/tuning.ts`: every bandwidth/quality knob for the guest's stream
  in one place — game speed (90% of the original cabinet, so shots are
  reactable over the stream), video bitrate ceiling (450 kbps, and video
  outranks audio under contention), capture fps, codec order
  (VP9 → H264 → VP8), smooth-over-sharp degradation policy, Opus caps
  (mono + FEC, DTX on the voice lane), input heartbeat timing, and the
  thresholds for the guest's stream-health dot. Verify with `chrome://webrtc-internals` (host
  `outbound-rtp` bitrate, fmtp lines in the SDP). Note Chrome DevTools
  network throttling does **not** touch WebRTC's UDP traffic — for a real
  constrained-link test use macOS Network Link Conditioner or `dnctl`.
- Guest inputs ride an **unordered** DataChannel as full-pad-state snapshots
  with a sequence number and a short heartbeat (`src/client/buttons.ts`), so
  one lost packet can neither delay the inputs behind it nor wedge a button.
- `src/client/buttons.ts`: if FBNeo maps the cabinet's two buttons to different
  RetroPad ids, adjust `FIRE1`/`FIRE2` there.
- WebRTC uses STUN only. If two phones on strict carrier NATs can't connect, add a
  TURN server (e.g. Cloudflare Realtime TURN) to `ICE_SERVERS` in
  `src/client/rtc.ts`.
- EmulatorJS loads from its CDN (`cdn.emulatorjs.org`); self-host the `data/`
  directory under `public/` and change `EJS_CDN` in `src/client/host.ts` to remove
  that dependency.

## License

The original code in this repository is licensed under the [MIT License](LICENSE).
This does not extend to any third-party game assets (see disclaimer below), which
are not included here.

## Disclaimer

*Squash* (1992) and all related game assets, artwork, audio, and ROM data are the
property of **Gaelco, S.A.**, the original developer and copyright holder. This
project is an unofficial, non-commercial fan harness with no affiliation with,
endorsement by, or sponsorship from Gaelco. It bundles **no** ROM, game art, audio,
or other Gaelco material; those files are gitignored and you must supply your own
legally obtained copy of the romset to play. Only the original networking, client,
and server code in this repository is offered under its license. If you are a Gaelco
rightsholder and want this taken down, open an issue and it will be removed.
