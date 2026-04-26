/** Signal Desktop message types for Note to Self extraction. */

export interface SignalConversation {
  id: string;
  type: string;
  name: string | null;
  profileName: string | null;
  profileFullName: string | null;
  e164: string | null;
  serviceId: string | null;
  active_at: number | null;
}

export interface SignalMessage {
  id: string;
  conversationId: string;
  sent_at: number;
  received_at: number;
  type: string;
  body: string | null;
  hasAttachments: number;
  hasFileAttachments: number;
  hasVisualMediaAttachments: number;
  sourceServiceId: string | null;
}

export interface AttachmentMeta {
  messageId: string;
  contentType: string;
  path: string | null;
  fileName: string | null;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  attachmentType: string;
}

export interface SignalAccountIdentity {
  e164: string;
  uuid: string;
}

export interface NoteToSelfMessage {
  id: string;
  conversationId: string;
  sentAt: number;
  body: string | null;
  attachments: AttachmentMeta[];
}

export interface SignalCollectorState {
  lastProcessedAt: number;
  lastRunAt: string | null;
  totalProcessed: number;
}

export type PrefixTag = "idea" | "task" | "learn" | "yt" | "buy" | "link" | "secret";

export type RouteDestination =
  | "ticket-idea"
  | "ticket-task"
  | "ticket-buy"
  | "youtube-queue"
  | "spike-queue"
  | "bookmark"
  | "sensitive"
  | "daily-log"
  | "attachment-only";

export interface RoutingResult {
  destination: RouteDestination;
  content: string;
  tag: PrefixTag | null;
  detectedUrl: string | null;
  sensitiveDetected: boolean;
  attachmentOnly: boolean;
  attachmentPaths: string[];
}

export interface ParsedSignalNote {
  frontmatter: Record<string, string>;
  body: string;
}
