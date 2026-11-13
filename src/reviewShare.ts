/**
 * A `wart review` run from a folder of repos is one request shared by every
 * repo's tab. Each tab's review pane registers here, so sending from any of
 * them hands the agent the comments of all of them at once.
 */
export interface Contribution {
  repo: string;
  /** The repo's review as a markdown section, or null if empty. */
  section: () => string | null;
  /** It was sent: archive it and start a new review there. */
  sent: () => void;
}

const byReply = new Map<string, Map<string, Contribution>>();

export function contribute(reply: string, tabId: string, c: Contribution): () => void {
  const m = byReply.get(reply) ?? new Map<string, Contribution>();
  m.set(tabId, c);
  byReply.set(reply, m);
  return () => {
    if (m.get(tabId) !== c) return;
    m.delete(tabId);
    if (!m.size) byReply.delete(reply);
  };
}

/** The reviews written in the other repos sharing this request. */
export function others(reply: string, tabId: string): { section: string; sent: () => void }[] {
  const out: { section: string; sent: () => void }[] = [];
  for (const [id, c] of byReply.get(reply) ?? []) {
    if (id === tabId) continue;
    const section = c.section();
    if (section) out.push({ section, sent: c.sent });
  }
  return out;
}
