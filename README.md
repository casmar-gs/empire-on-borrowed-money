# Empire on Borrowed Money — playable prototype

A turn-based 1920s tycoon. Build a business empire across the Lower East Side and
out-build the financier **Cornelius Vane** in 24 weeks — on borrowed money.

**▶ Play:** _(link appears here once GitHub Pages is enabled)_

## The loop
- Build shops on a 24-lot city grid. Diverse neighbours boost each other (synergy),
  but each district's customers are **finite and shared with your rival** — overbuild
  and everyone earns less.
- **Borrow** to claim ground before Vane. But a **credit crunch** can foreclose your
  weakest properties. Survive the cycle; race Vane's net worth to the deadline.

## Files
| file | what it is |
|---|---|
| `index.html` | the game — self-contained, this is what gets served |
| `game.js` | engine (single source of truth) |
| `ui-shell.html` | the UI shell |
| `build.js` | inlines `game.js` into `ui-shell.html` → `index.html` (`node build.js`) |
| `sim.js` | headless balance sim — 9 bot strategies × 1000 games with pass/fail gates (`node sim.js 1000`) |
| `server.js` | tiny local dev server (`node server.js` → http://localhost:8741) |
| `ANALYTICS-SETUP.md` | how the anonymous play telemetry is wired to a Google Sheet |

This prototype records **anonymous** gameplay stats (no personal data) to help balance it.
