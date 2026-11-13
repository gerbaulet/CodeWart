import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, errorMessage } from "../api";
import { formatWhen } from "../reviewArchive";
import type { AgentSession, PendingReview, ReviewComment, ReviewSession } from "../types";
import { relativeTime, reviewMarkdown } from "../util";
import { ChevronDown, Copy, Send } from "./Icons";
import { Popover } from "./Popover";
import { contribute, others } from "../reviewShare";

interface Props {
  worktree: string;
  /** Repository name (heads its section in a review shared by several repos). */
  repoName: string;
  /** Stable id of this tab. */
  tabId: string;
  target: string;
  comments: ReviewComment[];
  onRemove: (id: string) => void;
  onJump: (c: ReviewComment) => void;
  onClear: () => void;
  note: string;
  onNote: (s: string) => void;
  toast: (msg: string, err?: boolean) => void;
  /** Bumps whenever the worktree changes on disk (the agent produced a new version). */
  diskVersion: number;
  /** Past review sessions of this worktree, newest first. */
  sessions: ReviewSession[];
  /** Archive a handed-over review and clear what it contained. */
  onArchive: (snap: ReviewSnapshot, via: "session" | "copy", sentTo?: string) => ReviewSession;
  /** An agent ran `wart review` and is waiting for this review. */
  request?: PendingReview;
  onRequestDone: () => void;
}

/** What the waiting agent receives when there is nothing to change. */
const APPROVED = "APPROVED: the reviewer looked at the changes and has no further feedback.";
const DISMISSED = "DISMISSED: the reviewer declined to review right now. Continue without review feedback.";

/** The review exactly as it was handed to the agent. */
export interface ReviewSnapshot {
  target: string;
  comments: ReviewComment[];
  note: string;
  markdown: string;
}

export function ReviewPane({
  worktree,
  repoName,
  tabId,
  target,
  comments,
  onRemove,
  onJump,
  onClear,
  note,
  onNote,
  toast,
  diskVersion,
  sessions: past,
  onArchive,
  request,
  onRequestDone,
}: Props) {
  const [includeCode, setIncludeCode] = useState(true);
  const [preview, setPreview] = useState(false);
  const [submit, setSubmit] = useState(true);
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Hovering Copy / Send shows what will be sent. Small delays avoid flicker and
  // let the pointer travel into the preview to scroll it.
  const [previewOpen, setPreviewOpen] = useState(false);
  const peekTimer = useRef<number | undefined>(undefined);
  const showPreview = (on: boolean) => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPreviewOpen(on), on ? 250 : 180);
  };
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);

  const markdown = useMemo(
    () => reviewMarkdown({ comments, note, target, includeCode }),
    [comments, note, target, includeCode],
  );
  const empty = comments.length === 0 && !note.trim();
  const snapshot = (): ReviewSnapshot => ({ target, comments, note, markdown });

  // A copied review waits for the agent's next version, then asks to be archived.
  const [pending, setPending] = useState<{ snap: ReviewSnapshot; version: number } | null>(null);
  const [openSession, setOpenSession] = useState<number | null>(null);

  const copyText = async (text: string, msg: string) => {
    try {
      await writeText(text);
    } catch (e) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        toast(errorMessage(e), true);
        return false;
      }
    }
    toast(msg);
    return true;
  };

  const copy = async () => {
    const snap = snapshot();
    if (await copyText(markdown, "Review copied as markdown")) setPending({ snap, version: diskVersion });
  };

  // Ask only while the copied review is still here (not cleared or already archived).
  const stillHere =
    !!pending &&
    (pending.snap.comments.some((c) => comments.some((x) => x.id === c.id)) ||
      (!!pending.snap.note.trim() && note.trim() === pending.snap.note.trim()));
  const askArchive = !!pending && diskVersion > pending.version && stillHere;
  const nextNumber = (past[0]?.n ?? 0) + 1;

  const archiveCopied = () => {
    if (!pending) return;
    const r = onArchive(pending.snap, "copy");
    setPending(null);
    toast(`Archived as review #${r.n} · new review started`);
  };

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions(worktree));
    } catch (e) {
      setSessions([]);
      toast(errorMessage(e), true);
    }
  }, [worktree, toast]);

  // A request shared by a folder of repos: offer this repo's review to the others.
  const latest = useRef({ empty, snapshot, onArchive });
  latest.current = { empty, snapshot, onArchive };
  const shared = !!request?.group;
  const section = (md: string) => `## ${repoName}\n\n${md.trimEnd()}`;
  useEffect(() => {
    if (!request?.group) return;
    return contribute(request.reply, tabId, {
      repo: repoName,
      section: () => (latest.current.empty ? null : section(latest.current.snapshot().markdown)),
      sent: () => {
        const l = latest.current;
        if (!l.empty) l.onArchive(l.snapshot(), "session", "agent (wart review)");
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.reply, request?.group, tabId, repoName]);

  /** Answer a `wart review` request: the waiting agent prints this and continues. */
  const reply = async (text: string, archive: boolean) => {
    if (!request) return;
    setBusy(true);
    try {
      const snap = snapshot();
      // A folder of repos: include what was written in the other repos too.
      const rest = shared && text !== DISMISSED ? others(request.reply, tabId) : [];
      if (rest.length) {
        const parts = [...(archive ? [section(text)] : []), ...rest.map((o) => o.section)];
        text = `# Review of ${request.group!.name} (${parts.length} of ${request.group!.repos} repositories with feedback)\n\n${parts.join("\n\n")}`;
      }
      await api.writeReviewReply(request.reply, text);
      for (const o of rest) o.sent();
      onRequestDone();
      setPending(null);
      if (archive) {
        const r = onArchive(snap, "session", "agent (wart review)");
        toast(`Review sent to the agent · archived as review #${r.n}${rest.length ? ` · with ${rest.length} more repo${rest.length === 1 ? "" : "s"}` : ""}`);
      } else if (rest.length) toast(`Review of ${rest.length} repo${rest.length === 1 ? "" : "s"} sent to the agent`);
      else toast(text === APPROVED ? "Approved: the agent continues" : "Review request dismissed");
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };

  const send = async (s: AgentSession) => {
    setPickOpen(false);
    setBusy(true);
    try {
      const snap = snapshot();
      await api.injectText(s.id, markdown.trimEnd(), submit);
      const r = onArchive(snap, "session", s.label);
      setPending(null);
      toast(`Sent to ${s.label} · archived as review #${r.n}`);
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pane fl review" aria-label="Review">
      <div className="panehead">
        <div className="rhead">
          <h2 className="h2">Review</h2>
          {comments.length > 0 && (
            <button
              className="linkbtn"
              onClick={onClear}
              title={`Remove ${comments.length} comment${comments.length === 1 ? "" : "s"} and the notes`}
            >
              clear {comments.length}
            </button>
          )}
        </div>
        <div className="seg">
          <button className={!preview ? "on" : ""} onClick={() => setPreview(false)}>
            write
          </button>
          <button className={preview ? "on" : ""} onClick={() => setPreview(true)}>
            markdown
          </button>
        </div>
      </div>
      {/* Scrolls as a whole when the pane is short; the send row stays put. */}
      <div className="rbody">
        {request && (
          <div className="rrequest" role="status">
            <div className="r1">
              <span className="waitdot" />
              <b>The agent is waiting for your review</b>
              <span className="faint">{relativeTime(request.at / 1000)}</span>
            </div>
            {request.message && <p className="msg">{request.message}</p>}
            {request.group && (
              <p className="msg">
                For all {request.group.repos} repos in {request.group.name}: sending from any of them includes the comments of every repo.
              </p>
            )}
            <div className="row">
              <button className="linkbtn" disabled={busy} onClick={() => void reply(APPROVED, false)} title="Tell the agent there is nothing to change">
                approve, no changes
              </button>
              <button className="linkbtn" disabled={busy} onClick={() => void reply(DISMISSED, false)} title="Release the agent without a review">
                dismiss
              </button>
            </div>
          </div>
        )}
        {comments.length > 0 && !preview && (
          <div className="clist">
            {comments.map((c) => (
              <div key={c.id} className="citem" onClick={() => onJump(c)}>
                <span className="loc">
                  {c.symbol ? `${c.symbol} · ` : ""}
                  {c.file}
                  {c.line > 0 ? `:${c.line}` : " · whole file"}
                </span>
                <button
                  className="rm"
                  aria-label="Remove comment"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(c.id);
                  }}
                >
                  ×
                </button>
                <span className="txt">{c.body}</span>
              </div>
            ))}
          </div>
        )}
        <div className="mdwrap">
          {preview ? (
            <pre>{markdown}</pre>
          ) : (
            <textarea
              value={note}
              onChange={(e) => onNote(e.target.value)}
              placeholder={
                comments.length
                  ? "Overall notes for the agent (markdown)…"
                  : "Write feedback in markdown, or click a line number in the diff to comment on code."
              }
              aria-label="Review notes"
            />
          )}
        </div>
        {askArchive && (
          <div className="rprompt" role="alert">
            <p>
              The agent made changes since you copied this review. Treat them as the new version and archive this as{" "}
              <b>review #{nextNumber}</b>?
            </p>
            <div className="row">
              <button className="btn sm pri" onClick={archiveCopied}>
                Archive &amp; start new review
              </button>
              <button className="btn sm" onClick={() => setPending(null)}>
                Not now
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="rfoot">
        <div className="row">
          <label className="chk">
            <input type="checkbox" checked={includeCode} onChange={(e) => setIncludeCode(e.target.checked)} />
            include code
          </label>
          <label className="chk">
            <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
            press Enter after send
          </label>
        </div>
        <div
          className="row sendrow"
          onMouseEnter={() => showPreview(true)}
          onMouseLeave={() => showPreview(false)}
          onFocus={() => showPreview(true)}
          onBlur={() => showPreview(false)}
        >
          {previewOpen && !pickOpen && !empty && (
            <div className="promptpeek" role="tooltip" aria-label="Prompt preview">
              <div className="cap">
                Prompt preview <span className="faint">· {markdown.length.toLocaleString()} chars</span>
              </div>
              <pre>{markdown.trimEnd()}</pre>
            </div>
          )}
          <button className="btn" onClick={copy} disabled={empty}>
            <Copy size={14} /> Copy
          </button>
          {request ? (
            <button className="btn pri" style={{ flex: 1 }} disabled={(empty && !shared) || busy} onClick={() => void reply(empty ? APPROVED : markdown.trimEnd(), !empty)}>
              <Send size={14} /> Send to agent
            </button>
          ) : (
            <div style={{ position: "relative", flex: 1 }}>
              <button
                className="btn pri"
                style={{ width: "100%" }}
                disabled={empty || busy}
                onClick={() => {
                  setPickOpen((o) => !o);
                  void loadSessions();
                }}
              >
                <Send size={14} /> Send to session <ChevronDown />
              </button>
              <Popover open={pickOpen} onClose={() => setPickOpen(false)} align="right" up>
                <div className="cap">Agent sessions in this worktree</div>
                {sessions === null && <div className="m" style={{ padding: "8px 12px" }}>Scanning…</div>}
                {sessions?.length === 0 && (
                  <div className="m" style={{ padding: "8px 12px", whiteSpace: "normal", lineHeight: 1.5 }}>
                    No tmux, WezTerm or kitty pane is running in this worktree. Use Copy and paste into your agent instead.
                  </div>
                )}
                {sessions?.map((s) => (
                  <button key={s.id} className="opt" onClick={() => send(s)}>
                    <span className="r1">
                      {s.command || "shell"}
                      {s.isAgent && <span className="badge added">agent</span>}
                    </span>
                    <span className="m">{s.label}</span>
                  </button>
                ))}
              </Popover>
            </div>
          )}
        </div>
      </div>
      {past.length > 0 && (
        <div className="rhist" aria-label="Past reviews">
          <div className="cap">Past reviews</div>
          {past.map((r) => {
            const open = openSession === r.n;
            const count = r.comments.length;
            return (
              <div key={r.n} className={`rh${open ? " open" : ""}`}>
                <button className="rh-row" onClick={() => setOpenSession(open ? null : r.n)} aria-expanded={open}>
                  <b>#{r.n}</b>
                  <span>{formatWhen(r.at)}</span>
                  <span className="grow" />
                  <span className="faint" title={`${count} comment${count === 1 ? "" : "s"}`}>
                    {count} · {r.via === "session" ? "sent" : "copied"}
                  </span>
                </button>
                {open && (
                  <div className="rh-body">
                    <div className="m">
                      {r.target}
                      {r.sentTo ? ` · sent to ${r.sentTo}` : " · copied & pasted"}
                    </div>
                    <pre>{r.markdown.trimEnd()}</pre>
                    <button className="linkbtn" onClick={() => void copyText(r.markdown, `Review #${r.n} copied`)}>
                      copy again
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
