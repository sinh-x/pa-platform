import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ContentReviewView, HandoffBranchIntent, HandoffReviewRequest, HandoffReviewSubject } from "@pa-platform/pa-core";

export type HandoffReviewOutcome = "approved" | "changes-requested" | "rejected" | "cancelled";
export interface HandoffReviewUi {
  custom?<T>(factory: (tui: TUI, theme: Theme, keys: unknown, done: (result: T) => void) => Component): Promise<T>;
}
interface HandoffReviewView {
  subject: HandoffReviewSubject;
  intent: HandoffBranchIntent;
  presentation: Record<string, unknown>;
  documents: { id: string; mediaType: string; sha256: string; content: string | null }[];
}
const safe = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u202a-\u202e\u2066-\u2069]/g, "\ufffd");

class HandoffReviewDialog implements Component {
  private tab = 0; private scroll = 0; private choice = 3; private width = -1; private lines: string[] = [];
  private readonly views: { title: string; content: string }[];
  private readonly choices: string[];
  private readonly contentOnly: boolean;
  constructor(private readonly tui: Pick<TUI, "requestRender" | "terminal">, private readonly theme: Pick<Theme, "fg">,
    request: HandoffReviewRequest, view: HandoffReviewView | ContentReviewView, private readonly done: (result: HandoffReviewOutcome) => void) {
    this.contentOnly = "document" in view;
    if ("document" in view) {
      this.choices = ["Approve exact content — Not published", "Request changes", "Reject", "Cancel"];
      this.views = [{ title: "Sign only", content: `${view.document.ticket} · ${view.document.packageId} · revision ${view.document.revision} · Sign only\nLocal unverified confirmation: no authentication is provided. This is not authenticated human consent.\n\nApproval saves only this exact content decision. It grants and invokes no publication, ref/link/branch, queue, ticket status, resources or launch.\nReference: ${view.reference}\n\nEvery required member is available in tabs, with full reader/raw/manifest locations in Delivery. Tab changes view; PageUp/PageDown scrolls. Images remain opaque unless separately observed.\n\nDefault selection is Cancel. Escape or choosing Cancel deliberately cancels the shared request. Disconnect detaches and leaves it pending. A saved decision closes all clients without another unchanged prompt.` },
        ...view.documents.map(document => ({ title: document.id, content: document.content ?? `Opaque ${document.mediaType}; automatic viewing is not claimed. SHA-256 ${document.sha256}` })),
        { title: "Delivery", content: JSON.stringify({ inventory: view.document.members, presentation: view.presentation }, null, 2) }];
      return;
    }
    const effects = view.subject.effects;
    this.choices = [request.operation === "revoke" ? "Revoke this exact decision" : "Approve exact handoff and finite effects", "Request changes", "Reject", "Cancel"];
    this.views = [{ title: "Overview", content: `${view.subject.schemaVersion === "pa-handoff-review/v2" ? "Local unverified confirmation: no authentication is provided. Any local process with endpoint access can submit a decision; this is not authenticated human consent. Publication/ref/queue still require their own admission.\n\n" : ""}${view.intent.ticket}: ${request.operation === "revoke" ? `revoke ${request.targetDecisionId}` : "native requirements handoff review"}\nRepository: ${view.intent.repository.key} (${view.intent.repository.root})\nBranch: ${view.intent.branch}\nBase: ${view.intent.base.sha} (${view.intent.base.provenance}; remote freshness ${view.intent.base.remoteFreshness})\nPlan: ${view.intent.action}; observed develop ${view.intent.base.observedDevelopSha}\nEffects: publish=${effects.publish}; branch ref/link=${effects.branchRef}; queue=${effects.queue}\n\nAll immutable documents and exact technical bindings are available in tabs. Tab changes view; PageUp/PageDown scrolls. Images remain opaque unless separately observed.\n\nApprove authorizes only the displayed finite effects through their existing owners. It does not prepare a checkout, allocate capacity, launch implementation, push, merge, install, prove viewing or grant product UAT. Default selection is Cancel. An unchanged original request reuses this one interaction; changed content, branch, base or effects requires a new review.` },
      ...view.documents.map(document => ({ title: document.id, content: document.content ?? `Opaque ${document.mediaType}; automatic viewing is not claimed. SHA-256 ${document.sha256}` })),
      { title: "Technical bindings", content: JSON.stringify({ request, subject: view.subject, intent: view.intent, presentation: view.presentation }, null, 2) }];
  }
  invalidate(): void { this.width = -1; }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.done("cancelled");
    if (matchesKey(data, Key.enter)) return this.done((["approved", "changes-requested", "rejected", "cancelled"] as const)[this.choice]!);
    if (matchesKey(data, Key.up)) this.choice = (this.choice + 3) % 4;
    else if (matchesKey(data, Key.down)) this.choice = (this.choice + 1) % 4;
    else if (matchesKey(data, Key.tab)) { this.tab = (this.tab + 1) % this.views.length; this.scroll = 0; this.invalidate(); }
    else if (matchesKey(data, Key.pageDown)) this.scroll = Math.min(Math.max(0, this.lines.length - 1), this.scroll + 10);
    else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - 10);
    else return;
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const bounded = Math.max(1, width);
    if (this.width !== bounded) { this.lines = safe(this.views[this.tab]!.content).split("\n").flatMap(line => wrapTextWithAnsi(line, bounded)); this.width = bounded; }
    const height = Math.max(1, Math.min(20, this.tui.terminal.rows - 8));
    this.scroll = Math.min(this.scroll, Math.max(0, this.lines.length - height));
    return [this.theme.fg("accent", `${this.contentOnly ? "Content review" : "Native handoff"} — one final decision — ${this.views[this.tab]!.title} (${this.tab + 1}/${this.views.length})`),
      ...this.lines.slice(this.scroll, this.scroll + height),
      this.theme.fg("dim", `Lines ${this.scroll + 1}–${Math.min(this.lines.length, this.scroll + height)}/${this.lines.length}; Tab view · PgUp/PgDn scroll`),
      ...this.choices.map((choice, index) => `${index === this.choice ? "> " : "  "}${choice}`),
      this.theme.fg("dim", this.contentOnly ? "↑/↓ select · Enter decides once · Esc cancels · No publication/launch/UAT grant" : "↑/↓ select · Enter decides once · Esc cancels · No checkout/launch/UAT grant"),
    ].map(line => truncateToWidth(line, bounded));
  }
}
export function showHandoffReview(ui: HandoffReviewUi, request: HandoffReviewRequest, view: HandoffReviewView | ContentReviewView, signal?: AbortSignal): Promise<HandoffReviewOutcome>;
export function showHandoffReview(ui: HandoffReviewUi, request: HandoffReviewRequest, view: HandoffReviewView | ContentReviewView, signal: AbortSignal | undefined, abortOutcome: "detached"):  Promise<HandoffReviewOutcome | "detached">;
export async function showHandoffReview(ui: HandoffReviewUi, request: HandoffReviewRequest, view: HandoffReviewView | ContentReviewView, signal?: AbortSignal, abortOutcome: "cancelled" | "detached" = "cancelled"): Promise<HandoffReviewOutcome | "detached"> {
  if (!ui.custom) throw new Error("DOCUMENT_UI_UNAVAILABLE");
  let abort: (() => void) | undefined;
  try {
    return await ui.custom<HandoffReviewOutcome | "detached">((tui, theme, _keys, done) => {
      let finished = false;
      const finish = (result: HandoffReviewOutcome | "detached") => { if (!finished) { finished = true; done(result); } };
      abort = () => finish(abortOutcome); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      return new HandoffReviewDialog(tui, theme, request, view, finish);
    });
  } finally { if (abort) signal?.removeEventListener("abort", abort); }
}
