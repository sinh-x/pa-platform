export interface DecisionPayloadInput {
  ticketId: string;
  objective: string;
  findings: string;
  verification: string;
  question: string;
  options: string;
}

const MAX_LENGTH = 1500;

export function buildDecisionPayload(input: DecisionPayloadInput): string {
  const clean = (value: string): string => value.replace(/\?/g, ".").replace(/\s+/g, " ").trim();
  const suffix = ` Options: ${clean(input.options)} Decision: ${clean(input.question)}?`;
  const prefix = `Ticket: ${clean(input.ticketId)} Proposal: ${clean(input.objective)} Evidence/Findings: ${clean(input.findings)} Verification: ${clean(input.verification)}.`;
  if (prefix.length + suffix.length <= MAX_LENGTH) return `${prefix}${suffix}`;
  const prefixBudget = Math.max(0, MAX_LENGTH - suffix.length);
  return `${prefix.slice(0, prefixBudget)}${suffix}`;
}
