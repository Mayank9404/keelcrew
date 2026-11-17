/** Crew-wide controls in the top bar's More menu: usage, pause, do not disturb. */
import { useCallback, useRef, useState } from 'react';
import { LEAD } from '../../labels';
import { api } from '../../lib/api';
import { clock, dayTime, percent, toMs, until } from '../../lib/format';
import { patchCrew } from '../../lib/store';
import { toast } from '../../lib/toast';
import type { CrewState, UsageWindow } from '../../types';
import { Icon, useDismiss } from '../common';

export async function setAgentsPaused(paused: boolean): Promise<void> {
  try {
    const r = await api.setPaused(paused);
    patchCrew((h) => ({ ...h, paused: r.paused }));
    toast(r.paused ? 'Crew paused. Nothing new starts; running sessions stop at their next safe point.' : 'Crew resumed.');
  } catch {
    /* toasted */
  }
}

export async function setSchedulesPaused(paused: boolean): Promise<void> {
  try {
    await api.pauseSchedules(paused);
    toast(paused ? `Asked the ${LEAD} to pause the schedules. Running sessions keep going.` : `Asked the ${LEAD} to resume the schedules.`);
  } catch {
    /* toasted */
  }
}

export async function scanJira(): Promise<void> {
  try {
    await api.scan();
    toast('Asked for a Jira scan now: the Mate’s panel runs it within a minute.');
  } catch {
    /* toasted */
  }
}

function Meter({ label, name, w, now }: { label: string; name: string; w: UsageWindow; now: number }) {
  const p = Math.round(percent(w.utilization));
  const title = `${name}: ${p}% used, resets ${dayTime(w.resetsAt, now)} (in ${until(w.resetsAt, now)})`;
  return (
    <div className={p >= 100 ? 'meter full' : p >= 80 ? 'meter hot' : 'meter'} title={title}>
      <span className="m-l">{label}</span>
      <span className="m-bar" role="img" aria-label={title}>
        <i style={{ width: `${Math.min(100, p)}%` }} />
      </span>
      <span className="m-v">{p}%</span>
    </div>
  );
}

/** Usage read longer ago than this says when it was read, so old numbers never pass for current ones. */
const USAGE_STALE_MS = 30 * 60_000;

/** The plan's 5-hour and 7-day windows, when they were read if that was a while ago, and the usage guard when it holds new work. */
export function UsageMeters({ crew, now }: { crew: CrewState; now: number }) {
  const u = crew.usage;
  if (!u.fiveHour && !u.sevenDay) return null;
  return (
    <div className="usage" aria-label="Plan usage">
      {u.fiveHour ? <Meter label="5h" name="5-hour window" w={u.fiveHour} now={now} /> : null}
      {u.sevenDay ? <Meter label="7d" name="7-day window" w={u.sevenDay} now={now} /> : null}
      {u.updatedAt && now - toMs(u.updatedAt) > USAGE_STALE_MS ? <p className="usage-note stale" title={`Usage last read ${dayTime(u.updatedAt, now)}`}>as of {clock(u.updatedAt)}</p> : null}
      {u.status === 'rejected' ? <p className="usage-note block">Plan limit reached.</p> : u.guarded ? <p className="usage-note">{u.guardReason ?? 'Usage guard: no new work starts.'}</p> : null}
    </div>
  );
}

function tomorrowAt(hhmm: string): number {
  const [h, m] = (/^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '09:00').split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** A row button that opens a small menu above or beside it. */
function MenuButton({ icon, label, children, active, className }: { icon: Parameters<typeof Icon>[0]['name']; label: string; children: (close: () => void) => React.ReactNode; active?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div className={`pop-anchor ${className ?? ''}`} ref={ref}>
      <button type="button" className={active ? 'ctl on' : 'ctl'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} />
        <span className="ctl-l">{label}</span>
      </button>
      {open ? (
        <div className="popover menu" role="menu">
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

export function DndMenu({ crew, now }: { crew: CrewState; now: number }) {
  const off = !crew.config.pushNotifications;
  const muted = crew.dndUntil && crew.dndUntil > now ? crew.dndUntil : null;
  const start = /^\d{2}:\d{2}$/.test(crew.config.workingHours.start) ? crew.config.workingHours.start : '09:00';
  const set = async (v: number | null) => {
    try {
      const r = await api.setDnd(v);
      patchCrew((h) => ({ ...h, dndUntil: r.dndUntil }));
      toast(r.dndUntil ? `Notifications muted until ${clock(r.dndUntil)}.` : 'Notifications back on.');
    } catch {
      /* toasted */
    }
  };
  return (
    <MenuButton icon={muted || off ? 'bellOff' : 'bell'} label={off ? 'Notifications off' : muted ? `Muted until ${dayTime(muted, now).replace(/^Today /, '')}` : 'Notifications on'} active={!!muted && !off}>
      {(close) => off ? (
        <div className="menu-h">Push notifications are off. Turn them on in Settings → This Mac.</div>
      ) : (
        <>
          <div className="menu-h">Push notifications</div>
          {[
            ['Mute 1 hour', () => Date.now() + 3_600_000],
            ['Mute 3 hours', () => Date.now() + 3 * 3_600_000],
            [`Until tomorrow ${start}`, () => tomorrowAt(start)],
          ].map(([l, at]) => (
            <button key={l as string} type="button" className="mi" role="menuitem" onClick={() => (close(), void set((at as () => number)()))}>
              {l as string}
            </button>
          ))}
          {muted ? (
            <button type="button" className="mi" role="menuitem" onClick={() => (close(), void set(null))}>
              Turn them back on
            </button>
          ) : null}
        </>
      )}
    </MenuButton>
  );
}

/** Pause or resume the whole crew. */
export function PauseControl({ crew }: { crew: CrewState }) {
  if (!crew.access.canWrite) return null;
  return (
    <button type="button" className={crew.paused ? 'ctl on warn' : 'ctl'} onClick={() => void setAgentsPaused(!crew.paused)} title={crew.paused ? 'Resume the crew' : 'Pause the crew: nothing new starts'}>
      <Icon name={crew.paused ? 'play' : 'pause'} />
      <span className="ctl-l">{crew.paused ? 'Crew paused · Resume' : 'Pause the crew'}</span>
    </button>
  );
}
