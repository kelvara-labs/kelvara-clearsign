// Per-level behavior of the report UI (PLAN M5), kept DOM-free so it is unit tested.
//   L4 / blocked: report only, no Sign anyway (already rejected with 4001).
//   L3: held, Block focused by default, Sign anyway needs hold-to-confirm.
//   L2: held, Block and Sign anyway side by side.
//   L0/L1: full held review with Continue to wallet.
import type { WorkerVerdict } from "../shared/protocol.js";

export type ReportMode = "hold" | "info";

export function reportMode(v: Pick<WorkerVerdict, "allow" | "hold" | "level">): ReportMode {
  if (!v.allow && v.hold && v.level !== null && v.level <= 3) return "hold";
  return "info";
}

/** How long Sign anyway must be held at L3 (data-hold-ms). */
export const HOLD_MS = 2000;
/** Sign anyway stays disabled until the report has been fully visible this long (anti-clickjacking). */
export const MIN_VISIBLE_MS = 500;

export const LEVEL_NAMES = ["Clear", "Notice", "Warning", "Critical", "Blocked"] as const;

export interface Buttons {
  block: "Block" | "Dismiss";
  /** null: no Sign anyway element at all. */
  signAnyway: null | { holdMs: number | null };
  modal: boolean;
}

export function buttonsFor(v: Pick<WorkerVerdict, "allow" | "hold" | "level">): Buttons {
  const mode = reportMode(v);
  if (mode !== "hold") return { block: "Dismiss", signAnyway: null, modal: mode === "info" };
  return { block: "Block", signAnyway: { holdMs: v.level === 3 ? HOLD_MS : null }, modal: true };
}

export function statusLine(v: Pick<WorkerVerdict, "allow" | "hold" | "level">, secondsLeft: number): string {
  const mode = reportMode(v);
  if (mode === "hold") return `Your wallet has not been opened. No answer in ${secondsLeft} s means Block.`;
  return "Request rejected. Your wallet was not opened.";
}

/**
 * Hold-to-confirm state. Confirms only if a press started while the report was visible
 * and lasted holdMs without release, leave, cancel or blur. A plain click never confirms.
 */
export class HoldGesture {
  private startedAt: number | null = null;
  constructor(private readonly holdMs: number) {}
  press(now: number): void {
    if (this.startedAt === null) this.startedAt = now;
  }
  cancel(): void {
    this.startedAt = null;
  }
  get pressing(): boolean {
    return this.startedAt !== null;
  }
  /** True once the press has lasted holdMs. */
  done(now: number): boolean {
    return this.startedAt !== null && now - this.startedAt >= this.holdMs;
  }
  progress(now: number): number {
    return this.startedAt === null ? 0 : Math.min(1, (now - this.startedAt) / this.holdMs);
  }
}

/**
 * Visibility from IntersectionObserver v2 (trackVisibility): Sign anyway is enabled only
 * after the report has been unobscured for MIN_VISIBLE_MS. No v2 support = never enabled.
 */
export class VisibilityGate {
  private since: number | null = null;
  update(isVisible: boolean | undefined, now: number): void {
    if (isVisible === true) this.since ??= now;
    else this.since = null;
  }
  open(now: number): boolean {
    return this.since !== null && now - this.since >= MIN_VISIBLE_MS;
  }
}
