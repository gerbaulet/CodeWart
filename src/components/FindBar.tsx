import { useEffect, useRef, useState } from "react";

interface Props {
  /** Starts with this query (the selected text when opened). */
  initial: string;
  /** The element to search (the visible view). */
  root: () => HTMLElement | null;
  /** Changes whenever the shown content may have changed (search again). */
  version: string;
  onClose: () => void;
}

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): Highlights | null => {
  const css = globalThis.CSS as unknown as { highlights?: Highlights } | undefined;
  return css?.highlights && "Highlight" in globalThis ? css.highlights : null;
};
const mark = (name: string, ranges: Range[]) => {
  const reg = highlights();
  if (!reg) return;
  if (!ranges.length) return reg.delete(name);
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  reg.set(name, new H(...ranges));
};

/** Every case-insensitive match of `q` in the code lines under `root`. */
function search(root: HTMLElement, q: string): Range[] {
  const needle = q.toLowerCase();
  const out: Range[] = [];
  for (const code of root.querySelectorAll<HTMLElement>(".ln code")) {
    const text = code.textContent ?? "";
    if (!text.toLowerCase().includes(needle)) continue;
    // Map positions in the line's text back to its (highlighted) text nodes.
    const nodes: { node: Text; start: number }[] = [];
    const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let pos = 0;
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      nodes.push({ node: n, start: pos });
      pos += n.data.length;
    }
    const at = (i: number, end: boolean) => {
      let k = nodes.length - 1;
      while (k > 0 && (end ? nodes[k].start >= i : nodes[k].start > i)) k--;
      return { node: nodes[k].node, offset: i - nodes[k].start };
    };
    const hay = text.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
      const a = at(i, false), b = at(i + needle.length, true);
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      out.push(r);
    }
  }
  return out;
}

/** Find in the diff (⌥F): highlights every match, Enter / ⇧Enter step through them. */
export function FindBar({ initial, root, version, onClose }: Props) {
  const [q, setQ] = useState(initial);
  const [cur, setCur] = useState(0);
  const [count, setCount] = useState(0);
  const ranges = useRef<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    return () => {
      mark("cw-find", []);
      mark("cw-find-cur", []);
    };
  }, []);

  const show = (i: number, scroll: boolean) => {
    const r = ranges.current[i];
    mark("cw-find-cur", r ? [r] : []);
    if (!r) return;
    if (!highlights()) {
      // No highlight API: select the match instead so it's visible.
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
    if (scroll) r.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
  };

  // Search again when the query or the shown content changes.
  const lastQ = useRef<string | null>(null);
  useEffect(() => {
    const el = root();
    const found = el && q ? search(el, q) : [];
    ranges.current = found;
    setCount(found.length);
    mark("cw-find", found);
    const fresh = lastQ.current !== q;
    lastQ.current = q;
    const i = fresh ? 0 : Math.min(cur, Math.max(0, found.length - 1));
    setCur(i);
    show(i, fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, version]);

  const go = (d: number) => {
    const n = ranges.current.length;
    if (!n) return;
    const i = (cur + d + n) % n;
    setCur(i);
    show(i, true);
  };

  return (
    <div className="findbar" role="search">
      <input
        ref={input}
        value={q}
        placeholder="Find in diff"
        aria-label="Find in diff"
        spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="cnt">{q ? (count ? `${cur + 1}/${count}` : "no matches") : ""}</span>
      <button className="xbtn" onClick={() => go(-1)} disabled={!count} aria-label="Previous match" title="Previous (⇧⏎)">
        ↑
      </button>
      <button className="xbtn" onClick={() => go(1)} disabled={!count} aria-label="Next match" title="Next (⏎)">
        ↓
      </button>
      <button className="xbtn" onClick={onClose} aria-label="Close find" title="Close (esc)">
        ×
      </button>
    </div>
  );
}
