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
  const payload = `${prefix}${suffix}`;
  if (payload.length <= MAX_LENGTH) return payload;
  return `${payload.replace(/\?/g, ".").slice(0, MAX_LENGTH - 1)}?`;
}
