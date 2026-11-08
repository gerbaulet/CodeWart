import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, errorMessage } from "../api";
import type { AgentSession, ReviewComment } from "../types";
import { reviewMarkdown } from "../util";
import { ChevronDown, Copy, Send } from "./Icons";
import { Popover } from "./Popover";

interface Props {
  worktree: string;
  target: string;
  comments: ReviewComment[];
  onRemove: (id: string) => void;
  onJump: (c: ReviewComment) => void;
  onClear: () => void;
  note: string;
  onNote: (s: string) => void;
  toast: (msg: string, err?: boolean) => void;
}

export function ReviewPane({ worktree, target, comments, onRemove, onJump, onClear, note, onNote, toast }: Props) {
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

  const copy = async () => {
    try {
      await writeText(markdown);
      toast("Review copied as markdown");
    } catch (e) {
      try {
        await navigator.clipboard.writeText(markdown);
        toast("Review copied as markdown");
      } catch {
        toast(errorMessage(e), true);
      }
    }
  };

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions(worktree));
    } catch (e) {
      setSessions([]);
      toast(errorMessage(e), true);
    }
  }, [worktree, toast]);

  const send = async (s: AgentSession) => {
    setPickOpen(false);
    setBusy(true);
    try {
      await api.injectText(s.id, markdown.trimEnd(), submit);
      toast(`Sent to ${s.label}`);
      onClear();
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
      {comments.length > 0 && !preview && (
        <div className="clist">
          {comments.map((c) => (
            <div key={c.id} className="citem" onClick={() => onJump(c)}>
              <span className="loc">
                {c.symbol ? `${c.symbol} · ` : ""}
                {c.file}:{c.line}
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
        </div>
      </div>
    </section>
  );
}
