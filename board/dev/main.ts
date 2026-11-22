/**
 * Dev entry: installs the fake runtime with the example crew, then starts the real board. Query options:
 * `?viewer=guest` (read-only viewer), `?helper=off` (no `mcp` capability, like a phone), `?helper=down|denied|old|
 * decline|fail-approve|timeout-approve|slow` (comma-separated; see FakeOptions.helperMode), `?empty=1` (a new crew),
 * `?big=1` (300 more tasks and 1000 chat lines), `?crew=24` (that many engineers at work),
 * `?flaky=N` (the next N writes fail once with `unavailable`), `?motion=0` (reduced motion), `?idle=1` (no session
 * running on the Mac).
 * Not part of the production build (src/main.tsx is the board's only entry).
 */
import { FakeDb, installRuntime } from './fakeRuntime';
import { bigSeed, crowdSeed, seed, tools } from './scenario';

const q = new URLSearchParams(location.search);
const crowd = Number(q.get('crew'));
const db = new FakeDb(q.get('empty') === '1' ? {} : q.get('big') === '1' ? bigSeed() : crowd > 0 ? crowdSeed(crowd) : seed());
db.flakyWrites = Number(q.get('flaky')) || 0;
const helperParam = q.get('helper');
const calls: string[] = [];
db.log = calls;
// `?idle=1`: no session is running on the Mac (with `?empty=1`, a crew with nothing moving).
const helperTools = tools();
if (q.get('idle') === '1') helperTools.crew_state = () => ({ now: Date.now(), members: [] });
installRuntime({ db, owner: q.get('viewer') !== 'guest', tools: helperParam === 'off' ? null : helperTools, helperMode: helperParam && helperParam !== 'off' ? helperParam : null, log: calls });
// For checking by hand in the console: the fake store and the helper calls made, in order.
(window as unknown as { __crewDev: unknown }).__crewDev = { db, calls };

// A Mate that answers the captain's chat lines, so the flow can be tried.
let seen = Date.now();
setInterval(() => {
  const mine = [...db.docs.entries()].filter(([p, d]) => p.startsWith('chat/') && d.data.who === 'me' && (d.data.ts as number) > seen);
  for (const [, d] of mine) {
    seen = Math.max(seen, d.data.ts as number);
    setTimeout(() => db.write(`chat/lead-${Date.now()}`, () => ({ who: 'lead', text: `Noted: “${String(d.data.text).slice(0, 80)}”. I’ll take it from here.`, ts: Date.now() })), 1500);
  }
}, 1000);

// `?motion=0`: answer the reduced-motion media query with "reduce", as a system setting would.
if (q.get('motion') === '0') {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => (/prefers-reduced-motion:\s*reduce/.test(query) ? real('(min-width: 0px)') : real(query));
}

void import('../src/main');
