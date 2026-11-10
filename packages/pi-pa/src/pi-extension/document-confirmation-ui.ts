import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { NativeDocumentConfirmationRequest, DocumentConfirmation } from "@pa-platform/pa-core";

export type ConfirmationOutcome = DocumentConfirmation["outcome"];
export interface DocumentConfirmationUi {
  custom?<T>(factory: (tui: TUI, theme: Theme, keys: unknown, done: (result: T) => void) => Component): Promise<T>;
  notify?(message: string, level: "info" | "warning" | "error"): void;
}
const safe = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u202a-\u202e\u2066-\u2069]/g, "\ufffd");

/** One screen/decision. Document and technical tabs are optional reading, never
 * page acknowledgements or extra final approvals. No agent-injected outcome port. */
export class DocumentConfirmationDialog implements Component {
  private tab = 0;
  private scroll = 0;
  private choice = 3; // dismissal/accidental Enter never approves by default
  private width = -1;
  private lines: string[] = [];
  private readonly views: { title: string; content: string }[];
  readonly choices: string[];
  constructor(private readonly tui: Pick<TUI, "requestRender" | "terminal">, private readonly theme: Pick<Theme, "fg">,
    request: NativeDocumentConfirmationRequest, private readonly done: (result: ConfirmationOutcome) => void) {
    const p = request.subject;
    this.choices = [request.operation === "revoke" ? "Revoke this decision" : "Approve this exact scope", "Request changes", "Reject", "Cancel"];
    const scope = request.scope === "content" ? "Requirements content only. NO publication or queue." : request.scope === "publish" ? "Requirements content and publication of ALL exact members. NO queue." : "Requirements content, publication of ALL exact members, then queue for builder/orchestrator. Queue is NOT launch.";
    this.views = [{ title: "Overview", content: `${p.ticket}: ${request.operation === "revoke" ? `revoke ${request.revokes}` : "final package confirmation"}\nRepository: ${p.repository.key} (${p.repository.root})\nPackage ${p.packageId}, revision ${p.revision}\nScope: ${scope}\n${request.supersedes ? `Supersedes prior decision ${request.supersedes} for this same subject. The new response becomes latest; prior records remain.` : "No prior decision is superseded."}\n\n${request.brief}\n\nAll required members: ${p.members.map(m => m.id).join(", ")}\nFull immutable text is available in document tabs; Tab changes view, PageUp/PageDown scrolls. Images remain opaque; no automatic image/viewer observation.\nCompanion links and technical bindings are in the final tab.\n\nNo source execution, checkout/resource allocation or return, builder spawn, remote change, release/deployment or product acceptance. Local TUI/UID is managed-agent provenance, not independent real-world identity proof.\n${request.operation === "revoke" ? "Completed effects are not undone; original JSON is preserved." : "This is the single final decision, not an extra confirmation after chat."}` },
      ...request.documents.map(d => ({ title: d.id, content: d.content ?? `Opaque ${d.mediaType}; full image viewing is not claimed. SHA-256 ${d.sha256}` })),
      { title: "Links / technical bindings", content: JSON.stringify({ subjectSha256: request.sha256, subject: p, scope: request.scope, presentation: request.presentation }, null, 2) }];
  }
  invalidate(): void { this.width = -1; }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.done("cancelled"); return; }
    if (matchesKey(data, Key.enter)) { this.done((["approved", "changes-requested", "rejected", "cancelled"] as const)[this.choice]!); return; }
    if (matchesKey(data, Key.up)) this.choice = (this.choice + 3) % 4;
    else if (matchesKey(data, Key.down)) this.choice = (this.choice + 1) % 4;
    else if (matchesKey(data, Key.tab)) { this.tab = (this.tab + 1) % this.views.length; this.scroll = 0; this.invalidate(); }
    else if (matchesKey(data, Key.pageDown)) this.scroll = Math.min(Math.max(0, this.lines.length - 1), this.scroll + 10);
    else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - 10);
    else return;
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const w = Math.max(1, width);
    if (this.width !== w) { this.lines = safe(this.views[this.tab]!.content).split("\n").flatMap(line => wrapTextWithAnsi(line, w)); this.width = w; }
    const height = Math.max(1, Math.min(20, this.tui.terminal.rows - 8));
    this.scroll = Math.min(this.scroll, Math.max(0, this.lines.length - height));
    return [this.theme.fg("accent", `Native package decision — single final decision — ${this.views[this.tab]!.title} (${this.tab + 1}/${this.views.length})`),
      ...this.lines.slice(this.scroll, this.scroll + height),
      this.theme.fg("dim", `Lines ${this.scroll + 1}–${Math.min(this.lines.length, this.scroll + height)}/${this.lines.length}; Tab view · PgUp/PgDn scroll`),
      ...this.choices.map((c, i) => `${i === this.choice ? "> " : "  "}${c}`),
      this.theme.fg("dim", "↑/↓ select · Enter decides once · Esc cancels · No execution/launch/UAT grant"),
    ].map(line => truncateToWidth(line, w));
  }
}
export async function showDocumentConfirmation(ui: DocumentConfirmationUi, request: NativeDocumentConfirmationRequest, signal?: AbortSignal): Promise<ConfirmationOutcome> {
  if (!ui.custom) throw Error("DOCUMENT_UI_UNAVAILABLE");
  let abort: (() => void) | undefined;
  try {
    return await ui.custom<ConfirmationOutcome>((tui, theme, _keys, done) => {
      let finished = false;
      const finish = (result: ConfirmationOutcome) => { if (!finished) { finished = true; done(result); } };
      abort = () => finish("cancelled"); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      return new DocumentConfirmationDialog(tui, theme, request, finish);
    });
  } finally { if (abort) signal?.removeEventListener("abort", abort); }
}
