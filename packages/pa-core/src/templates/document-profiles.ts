import type { TemplateId } from "./schema.js";
/** Shape contracts, not canonical wording or authority. Exact headings remain
 * selected-config owned; minimums prevent a full report becoming one heading. */
export const DOCUMENT_PROFILES: Partial<Record<TemplateId, { minimumSections: number; headers: readonly string[] }>> = {
  requirements: { minimumSections: 16, headers: ["Ticket", "Repository Key", "Repository Root", "Class", "Route", "Status", "Handoff Type", "Feature Branch", "Matrix Authority SHA-256", "Review Revision"] },
  "uat-review": { minimumSections: 6, headers: ["Ticket", "Requirements", "Implementation", "Status", "Review Revision"] },
  "builder-objective": { minimumSections: 3, headers: ["Ticket", "Repository Key", "Repository Root", "Execution Model", "Status"] },
  "implementation-phase-report": { minimumSections: 8, headers: [] },
  "orchestration-report": { minimumSections: 4, headers: ["Ticket", "Repository Key", "Repository Root"] },
  "project-agent-guide": { minimumSections: 9, headers: ["Repository Key", "Repository Root", "Version"] },
  "spike-full-requirements": { minimumSections: 13, headers: ["Status", "Repository"] },
  "spike-learning-note": { minimumSections: 13, headers: [] },
  "spike-light-report": { minimumSections: 9, headers: ["Date", "Deployment"] },
  "spike-research-report": { minimumSections: 13, headers: [] },
  "uat-plan": { minimumSections: 6, headers: ["Ticket", "Requirements", "Revision", "Status", "Acceptance Criteria"] },
};
