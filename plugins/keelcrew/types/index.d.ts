/** A launch card waiting for the captain's choice. */
/** `head` is the commit the card was posted for (its receipts); `risk` its tier; `notPassing` validation checks not yet passing. */
export type ShipCard = { id: string; version: number; taskKey: string; title: string; body: string; head: string | null; risk: string | null; notPassing: number };

/** Something on the board: a card for the captain, or an item the Mate hasn't handled yet; `keys`, the tickets a Jira item names;
 * `push`, the Claude app push line of an urgent, ship or failed QA card for the captain (the only ones pushed). */
/** `doc`: a small changed document in full (`chat/<id> v<n> {…}`), so the Mate acts on it without reading it again. */
export type Pending = { id: string; label: string; keys?: string[]; push?: string; doc?: string };

/** A crew engineer, from what the hooks record on this Mac. */
export type Engineer = { key: string; activity: string; lastText: string; lastAt: number | null };

/** A ticket's board row as an engineer's band shows it; `waiting` is "you", "the Mate" or "", `cards` the open cards for the captain. */
export type Ticket = { title: string; phase: string; status: string; summary: string; waiting: string; prUrl: string; cards: string[] };

/** What the Keelcrew panel draws. */
export type CrewView = {
  at: number;
  error: string | null;
  ship: ShipCard[];
  pending: Pending[];
  forYou: Pending[];
  engineers: Engineer[];
  tickets: Record<string, Ticket>;
  /** `crew/lead.dndUntil`: no notifications for new cards before this time (epoch ms); null when not muted. */
  dndUntil: number | null;
  /** Open compact requests that are ready. */
  compact: CompactRequest[];
};

/** A board compact request that is `ready` (the board sets it, else the Mate): the session it names
 * (ticket `key`, and `agent`, null for the engineer) runs /compact between its turns. */
export type CompactRequest = { id: string; key: string; agent: string | null };

/** What the Mate's session writes to ~/.keelcrew/summary.json each minute, for engineers' and agents' sessions to read. */
export type CrewSummary = { at: number; tickets: Record<string, Ticket>; compact?: CompactRequest[] };

/** A Jira issue the Mate's panel found new or changed: key, summary, status name and Jira's `updated`; `from`, for a
 * changed one, the status the board row had; `by`, for a commented one, who wrote its newest new comment. */
export type JiraChange = { key: string; title: string; status: string; updated: string; from?: string; by?: string };

/** What the Mate's session writes to ~/.keelcrew/scan.json after each Jira scan, for the Mate and the helper's `crew_state`;
 * `truncated` when the scan stopped at its page limit with more issues left; `commented`, the updated ones with a new
 * comment by someone other than the captain; `commentsError`, why that check counted more than that (no account id, or its search failed). */
export type ScanFile = { at: number; ok: boolean; error?: string; truncated?: boolean; new: JiraChange[]; changed: JiraChange[]; updated: JiraChange[]; commented?: JiraChange[]; commentsError?: string };

/** A problem the panel's health checks found: `id` is stable while it lasts (the alert signature), `now` is the urgent kind. */
export type HealthIssue = { id: string; severity: 'now' | 'soon'; text: string };

/** What the Mate's session writes to ~/.keelcrew/health.json after its routine health checks; `ok` names the checks that passed. */
export type HealthFile = { at: number; issues: HealthIssue[]; ok: string[] };

/** One crew PR the Mate's panel saw merged (HOME/merges.json): the board page moves the row to `target`, or the Mate does. */
export type MergeRecord = { key: string; prUrl: string; prNumber: number | null; mergedAt: number | null; mergeSha: string | null; risk: string | null; target: 'done' | 'qa'; recordedAt: number; appliedAt?: number };

/** HOME/merges.json. */
export type MergesFile = { at: number; merges: MergeRecord[] };

/** A card the captain answered where the helper can't be reached (their phone), as the Mate's panel carried it out on this
 * Mac: the ticket, the answer, when it ran, and how it went (`text`, the outcome the Mate records on the card). */
export type PhoneGrant = { key: string; choice: string; at: number; ok: boolean; text: string };

/** HOME/phone-grants.json, keyed by "<card id> <answeredAt>", so each answer runs once. */
export type PhoneGrantsFile = Record<string, PhoneGrant>;

/** The strip above an engineer's prompt: its ticket from the Mate's summary, whether that summary is stale, and the captain's
 * live ship approval. */
export type Band = { key: string; ticket: Ticket | null; stale: boolean; ship: string | null };

/** The Harbour light look's crew states: working, waiting for the captain, failed, paused. */
/** work: being built; review: its PR is open; qa: waiting on QA or its deploy. */
export type CrewState = 'work' | 'review' | 'qa' | 'you' | 'bad' | 'paused';
/** A crew member at the harbour's jetty. */
export type Moored = { key: string; role: string; state: CrewState };
/** A watch (scheduled agent run) today: the last one done and the next ones. */
export type Watch = { at: string; name: string; state: 'done' | 'next' | 'later' };
/** The harbour's "This week": crew tickets merged, QA first passes of those QA judged, new lessons. */
export type Week = { shipped: number; qaPassed: number; qaKnown: number; lessons: number };
/** Each ticket's phase changes, oldest first (HOME/phases.json): the voyage track's time per stage. */
export type PhaseLog = Record<string, { phase: string; at: number }[]>;
/** What the Mate's session draws the harbour, its status row and the cards' tracks from. */
export type HarbourData = { at: number; waiting: number; paused: number; alerts: number; watches: Watch[]; week: Week | null; crew: Moored[]; phases: PhaseLog };
/** A card a ```keelcrew block in a reply or crew message draws. */
export type Card =
  | { kind: 'crew'; role: string; key: string; title: string; status: string; tone?: 'ok' | 'bad'; phase?: string; facts?: string[] }
  | { kind: 'you'; key: string; title: string; facts?: string[]; risk?: { tier: string; why: string[]; clear?: string } }
  | { kind: 'learned'; text: string; from?: string; state?: string }
  | { kind: 'deny'; key: string; command: string; note?: string }
  | { kind: 'wake'; text: string };

declare module 'claude-code' {
  interface PluginState {
    'keelcrew': {
      view: CrewView | null
      band: Band | null
      harbour: HarbourData | null
      /** This session's main turn while it runs (its id, and when it started, epoch ms). */
      turn: { id: string; at: number } | null
      /** The session id a /clear ended, and when, until its crew entry moves to the new id. */
      cleared: { from: string; at: number } | null
      /** The newer version the status line told this session to reload for, until a reload runs it. */
      updateNote: string | null
    };
  }
}
