/**
 * The Mate chat: the conversation, the Mate's session at a glance, and the composer. Docked beside every view on wide
 * screens; its own view on narrower ones.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LEAD } from "../../labels";
import { api } from "../../lib/api";
import { leadAsked, leadSession, leadStatus } from "../../lib/derive";
import { clock, dayTime, modelName, toMs } from "../../lib/format";
import { READ_ONLY_NOTE } from "../../lib/owner";
import { useCanWrite } from "../../lib/store";
import { canDock, ui } from "../../lib/ui";
import type { ChatMessage, CrewState, Session } from "../../types";
import { Dot, Icon, useDismiss } from "../common";
import { Markdown } from "../Markdown";
import { RetroBlock } from "../RetroBlock";
import { ContextMeter, SessionActions } from "../SessionBits";

interface Pending {
  id: string;
  text: string;
  ts: number;
}

/** A message's time and task line shows only when the sender, the task or the time (by 5 minutes) changes. */
const GROUP_MS = 5 * 60_000;

/** Day separators between messages from different days. */
const dayOf = (ts: number): string => new Date(toMs(ts)).toDateString();

function Messages({ crew, pending }: { crew: CrewState; pending: Pending[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const shown = pending.filter(
    (p) =>
      !crew.chat.some(
        (c) =>
          c.who === "me" &&
          c.text.trim() === p.text &&
          toMs(c.ts) >= p.ts - 60_000,
      ),
  );
  const all: (Pick<
    ChatMessage,
    "id" | "who" | "text" | "ts" | "retro" | "taskKey"
  > & { sending?: boolean })[] = [
    ...crew.chat,
    ...shown.map((p) => ({
      id: `p${p.id}`,
      who: "me" as const,
      text: p.text,
      ts: p.ts,
      retro: null,
      taskKey: null,
      sending: true,
    })),
  ];
  // Only the newest messages are loaded, so a new one can leave the count unchanged: follow the last message instead.
  const lastId = all.at(-1)?.id ?? "";
  const lastMine = all.at(-1)?.who === "me";
  const toEnd = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setUnseen(false);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !lastId) return;
    if (stick.current || lastMine) {
      el.scrollTop = el.scrollHeight;
      stick.current = true;
    } else setUnseen(true);
  }, [lastId, lastMine]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (stick.current) setUnseen(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <div className="messages-wrap">
      <div className="messages" ref={ref} aria-live="polite">
        {!all.length ? (
          <div className="empty">
            <b>Say hello to the {LEAD}.</b>
            <p>
              Ask anything, or describe a task: the {LEAD} answers here, turns
              work into tasks, and puts decisions on Sign-offs.
            </p>
          </div>
        ) : null}
        {all.map((m, i) => {
          const prev = all[i - 1];
          const newDay = i === 0 || dayOf(prev.ts) !== dayOf(m.ts);
          const meta =
            m.who !== "system" &&
            (newDay || m.sending || prev.who !== m.who || (m.taskKey && m.taskKey !== prev.taskKey) || toMs(m.ts) - toMs(prev.ts) > GROUP_MS);
          return (
            <div key={m.id} className="msg-wrap">
              {newDay ? (
                <div className="day">
                  {dayTime(m.ts).replace(/ · \d\d:\d\d$| \d\d:\d\d$/, "")}
                </div>
              ) : null}
              <div className={`msg ${m.who}`}>
                {meta ? (
                  <div className="who">
                    {m.sending ? "sending…" : clock(m.ts)}
                    {m.taskKey ? (
                      <button
                        type="button"
                        className="key"
                        onClick={() => ui.openTask(m.taskKey!)}
                      >
                        {m.taskKey}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className={m.sending ? "bubble sending" : "bubble"}>
                  {m.retro ? (
                    <RetroBlock retro={m.retro} text={m.text} />
                  ) : (
                    <Markdown text={m.text} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {unseen ? (
        <button type="button" className="btn sm jump-new" onClick={toEnd}>
          New message ↓
        </button>
      ) : null}
    </div>
  );
}

function Composer({ onSent }: { onSent: (p: Pending) => void }) {
  const canWrite = useCanWrite();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // Empty, one row is the height: measuring now could catch the panel before its width settles.
    if (text) el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  const send = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    const p = { id: String(Date.now()), text: v, ts: Date.now() };
    try {
      await api.chat(v);
      setText("");
      onSent(p);
    } catch {
      /* toasted; keep the text */
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={ref}
        id="chat-input"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={canWrite ? `Message the ${LEAD}` : READ_ONLY_NOTE}
        aria-label={`Message the ${LEAD}`}
        disabled={!canWrite}
      />
      <button
        className="send"
        type="submit"
        disabled={!canWrite || !text.trim() || sending}
        aria-label="Send"
      >
        <Icon name="send" />
      </button>
    </form>
  );
}

/** The Mate's session behind the ⋯ button: its model, context and actions, out of the conversation's way. */
function SessionMenu({ s }: { s: Session }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        type="button"
        className="btn icon ghost sm"
        aria-label={`The ${LEAD}'s session`}
        title={`The ${LEAD}'s session`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="dots" />
      </button>
      {open ? (
        <div className="popover chat-pop" role="dialog" aria-label={`The ${LEAD}'s session`}>
          <span className="lb-model">
            {modelName(s.model)} · {s.effort}
          </span>
          <ContextMeter s={s} />
          <SessionActions s={s} labels="long" />
        </div>
      ) : null}
    </div>
  );
}

export function ChatPanel({
  crew,
  docked,
}: {
  crew: CrewState;
  docked: boolean;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const s = leadSession(crew);
  const st = leadStatus(crew);
  useEffect(() => {
    if (!pending.length) return;
    const t = window.setTimeout(
      () => setPending((p) => p.filter((x) => Date.now() - x.ts < 60_000)),
      61_000,
    );
    return () => window.clearTimeout(t);
  }, [pending]);
  return (
    <section
      className={docked ? "chat docked" : "chat full"}
      aria-label={`${LEAD} chat`}
    >
      <header className="chat-head">
        <Dot tone={st.color} pulse={st.word === "busy"} />
        <b className="ch-name">{LEAD}</b>
        <span className={leadAsked(crew) ? "ch-state you" : "ch-state"}>
          {leadAsked(crew) ? "waiting for your reply" : st.word === "busy" ? st.short : st.word}
        </span>
        <span className="grow" />
        {s ? <SessionMenu s={s} /> : null}
        {docked ? (
          <button
            type="button"
            className="btn icon ghost sm"
            aria-label="Open the chat as a full page"
            title="Open the chat as a full page"
            onClick={() => ui.setView("chat")}
          >
            <Icon name="expand" />
          </button>
        ) : canDock() ? (
          <button
            type="button"
            className="btn icon ghost sm"
            aria-label="Dock the chat beside the board"
            title="Dock the chat beside the board"
            onClick={() => ui.setChatDock(true)}
          >
            <Icon name="sidebar" />
          </button>
        ) : null}
        {docked ? (
          <button
            type="button"
            className="btn icon ghost sm"
            aria-label="Hide the chat"
            title="Hide the chat"
            onClick={() => ui.setChatDock(false)}
          >
            <Icon name="x" />
          </button>
        ) : null}
      </header>
      <Messages crew={crew} pending={pending} />
      <Composer onSent={(p) => setPending((list) => [...list, p])} />
    </section>
  );
}
