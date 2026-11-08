import { useState } from "react";
import type { FileDiff, FileTag } from "../types";
import { TAG_LABEL } from "../util";

interface Props {
  visible: FileDiff[];
  hidden: { file: FileDiff; reason: FileTag }[];
  showHidden: boolean;
  onShowHidden: (v: boolean) => void;
  active: string | null;
  onPick: (path: string) => void;
}

const STATUS: Record<FileDiff["status"], { l: string; c: string }> = {
  added: { l: "A", c: "var(--add)" },
  deleted: { l: "D", c: "var(--del)" },
  modified: { l: "M", c: "var(--muted)" },
  renamed: { l: "R", c: "var(--mod)" },
  copied: { l: "C", c: "var(--mod)" },
};

function Row({ f, on, onPick, why }: { f: FileDiff; on: boolean; onPick: () => void; why?: string }) {
  const s = STATUS[f.status];
  return (
    <button className={`f${on ? " on" : ""}${why ? " hid" : ""}`} onClick={onPick} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
      <span className="st" style={{ color: s.c }}>{s.l}</span>
      <span className="p grow">
        <bdi>{f.path}</bdi>
      </span>
      {why ? (
        <span className="why">{why}</span>
      ) : (
        <span className="num">
          {f.binary ? (
            <span className="faint">bin</span>
          ) : (
            <>
              {f.additions > 0 && <span className="add-c">+{f.additions}</span>} {f.deletions > 0 && <span className="del-c">−{f.deletions}</span>}
            </>
          )}
        </span>
      )}
    </button>
  );
}

export function FilesPane({ visible, hidden, showHidden, onShowHidden, active, onPick }: Props) {
  const [hiddenOpen, setHiddenOpen] = useState(false);
  return (
    <aside className="pane fl files" aria-label="Changed files">
      <div className="panehead">
        <h2 className="h2">Files</h2>
        <span className="m">{visible.length}</span>
      </div>
      <div className="list">
        {visible.map((f) => (
          <Row key={f.path} f={f} on={active === f.path} onPick={() => onPick(f.path)} />
        ))}
        {visible.length === 0 && <div className="m" style={{ padding: "4px 18px" }}>No files</div>}
        {hidden.length > 0 && (
          <>
            <div className="hidhead">
              <button className="linkbtn" style={{ textDecoration: "none", color: "var(--muted)", fontSize: 13 }} onClick={() => setHiddenOpen((o) => !o)}>
                Hidden ({hidden.length}) {hiddenOpen ? "▾" : "▸"}
              </button>
              <button className="linkbtn" onClick={() => onShowHidden(!showHidden)}>
                {showHidden ? "hide again" : `show ${hidden.length}`}
              </button>
            </div>
            {(hiddenOpen || showHidden) &&
              hidden.map(({ file, reason }) => (
                <Row
                  key={file.path}
                  f={file}
                  on={active === file.path}
                  why={TAG_LABEL[reason]}
                  onPick={() => {
                    if (!showHidden) onShowHidden(true);
                    onPick(file.path);
                  }}
                />
              ))}
          </>
        )}
      </div>
    </aside>
  );
}
