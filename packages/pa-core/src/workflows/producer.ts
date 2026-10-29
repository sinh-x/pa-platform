import type { TemplateConsumerPort } from "../templates/service.js";
import { parseReviewBundle } from "./contracts.js";

/** Pure PAP-271-owned structural consumer, shared by the template hosts.
 * Registration enables unsigned review-bundle drafts only, never workflow
 * selection, decision capture, execution, publication or progression. */
export const reviewBundleTemplateConsumer: TemplateConsumerPort = Object.freeze({ schemaVersion: "pa-review-bundle/v1", validate: parseReviewBundle });
