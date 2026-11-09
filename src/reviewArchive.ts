import { useCallback, useState } from "react";
import type { ReviewSession } from "./types";

/** Past review sessions per worktree, newest first, kept in localStorage. */
const PREFIX = "codewart.reviews:";
const MAX = 200;

function load(worktree: string): ReviewSession[] {
  try {
    const v = localStorage.getItem(PREFIX + worktree);
    return v ? (JSON.parse(v) as ReviewSession[]) : [];
  } catch {
    return [];
  }
}

function save(worktree: string, list: ReviewSession[]) {
  try {
    localStorage.setItem(PREFIX + worktree, JSON.stringify(list));
  } catch {
    /* storage unavailable or full */
  }
}

export function useReviewArchive(worktree: string) {
  const [list, setList] = useState<ReviewSession[]>(() => load(worktree));
  const add = useCallback(
    (s: Omit<ReviewSession, "n">) => {
      // Re-read so two tabs on the same worktree never reuse a number.
      const current = load(worktree);
      const entry: ReviewSession = { ...s, n: (current[0]?.n ?? 0) + 1 };
      const next = [entry, ...current].slice(0, MAX);
      save(worktree, next);
      setList(next);
      return entry;
    },
    [worktree],
  );
  return { list, add };
}

/** "Nov 8, 9:09 PM", with the year only when it isn't this year. */
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(thisYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
