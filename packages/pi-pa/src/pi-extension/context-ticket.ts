import type { ContextTicketSummary } from "./context-reader.js";
import type { PaContextSnapshot } from "./context-state.js";
import { withDeadline } from "./context-state.js";

export interface ContextTicketBinding { deploymentId: string; project: string; ticket: string; cwd: string }
export type ContextTicketState =
  | { status: "withheld" | "none" | "loading" | "unavailable" }
  | { status: "ready"; ticket: ContextTicketSummary; readAt: number };

/** View-local generations supplement the deployment observation generation:
 * A→B→A, retry and close must all invalidate old bodies, not just compare IDs. */
export class ContextTicketReader {
  state: ContextTicketState = { status: "withheld" };
  private binding?: ContextTicketBinding;
  private generation = 0;
  private open = false;
  private running = false;
  private pending = false;
  constructor(private readonly lookup: (binding: ContextTicketBinding) => Promise<ContextTicketSummary | undefined>,
    private readonly changed: () => void, private readonly now = Date.now, private readonly deadline = 500) {}

  observe(snapshot: PaContextSnapshot): void {
    const d = snapshot.deployment;
    const binding = d.projectionAvailable && !d.stale && d.id && d.project && d.ticket
      ? { deploymentId: d.id, project: d.project, ticket: d.ticket, cwd: snapshot.repository.cwd } : undefined;
    if (JSON.stringify(binding) === JSON.stringify(this.binding)) {
      if (!binding) this.state = { status: d.projectionAvailable && !d.stale && !d.ticket ? "none" : "withheld" };
      return;
    }
    this.binding = binding;
    this.generation++;
    this.pending = false;
    this.state = { status: binding ? "loading" : d.projectionAvailable && !d.stale && !d.ticket ? "none" : "withheld" };
    this.changed();
    if (this.open && binding) this.retry();
  }
  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.generation++;
    this.pending = false;
    this.state = { status: this.binding ? "loading" : this.state.status === "none" ? "none" : "withheld" };
    if (open) this.retry();
  }
  retry(): void {
    if (!this.open || !this.binding) return;
    this.generation++;
    this.state = { status: "loading" };
    this.pending = true;
    this.changed();
    this.run();
  }
  private run(): void {
    if (this.running || !this.pending || !this.open || !this.binding) return;
    this.pending = false;
    this.running = true;
    const generation = this.generation, binding = this.binding;
    // Keep concurrency bounded even if an injected I/O owner ignores deadlines.
    const work = Promise.resolve().then(() => this.lookup(binding));
    void withDeadline(() => work, this.deadline).then(result => {
      if (generation !== this.generation || !this.open) return;
      const ticket = result.ok ? result.value : undefined;
      this.state = ticket && ticket.id === binding.ticket && ticket.project === binding.project
        ? { status: "ready", ticket, readAt: this.now() } : { status: "unavailable" };
      this.changed();
    });
    void work.catch(() => undefined).finally(() => {
      this.running = false;
      this.run();
    });
  }
}
