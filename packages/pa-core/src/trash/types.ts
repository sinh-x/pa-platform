export type TrashFileType = "skill" | "team" | "objective" | "mode" | "other";
export type TrashStatus = "trashed" | "restored" | "purged";

export interface TrashEntry {
  id: string;
  trashedAt: string;
  actor: string;
  reason: string;
  originalPath: string;
  fileType: TrashFileType;
  trashPath: string;
  status: TrashStatus;
  restoredAt?: string;
  purgedAt?: string;
}
