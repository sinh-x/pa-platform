---
name: handnote-combiner
description: Combines hand-written notes (from photos/images) with existing digital documents (Anytype objects, markdown files, or other text sources) into a single unified note. This skill should be used when the user provides photos of hand-written notes and asks to merge, combine, or integrate them with an existing digital document or note. Triggers include phrases like "combine hand notes", "merge my notes", "combine handwriting with document", "integrate my hand notes", "add my written notes to".
source: /home/sinh/.claude/skills/handnote-combiner/SKILL.md
---

# Handnote Combiner

Combine hand-written notes captured in photos with existing digital documents into a single, coherent, unified note.

## Workflow

### Phase 1: Extract Hand-Written Notes

Read all provided photos carefully, in order. Transcribe the hand-written content, preserving:

- **Timestamps** (e.g., 19:30, 20:15) — these are the structural backbone
- **Names of people** mentioned (speakers, group members, facilitators)
- **Key terms and concepts** — often underlined, in different ink colors, or emphasized
- **Activities described** — group discussions, presentations, exercises
- **Arrows and connections** between concepts — these indicate relationships
- **Slide keywords** — if the user noted which slide was showing at a timestamp (e.g., `[slide: eye tracking]`), record these for Phase 3 image mapping
- **Ink colors** — the user may use a color system. When visible, use colors as semantic cues:
    - **Black** = structure, timestamps, slide keywords
    - **Red** = key topics and concepts
    - **Blue** = facts, keywords, content
    - **Purple** = people names
    - **Green** = personal reflections and ideas
- **Language** — preserve the original language (Vietnamese, English, mixed)
- **Screenshot filenames** — note the exact filename of each slide screenshot (e.g., `Pasted image 20260415192304.png`). Date format is `YYYYMMDDHHMMSS`. Use the exact filename when embedding — do not reformat or guess the date pattern.

**Time format**: If times appear ambiguous (e.g., 07:15 could be AM or PM), ask the user or infer from context (evening classes = PM → 19:15).

Identify what the hand-notes uniquely add that a typed document likely lacks:

| Hand-notes typically provide | Digital docs typically provide |
|---|---|
| Timeline (when things happened) | Detailed content (what was taught) |
| People (who did what) | Theory & definitions |
| Activities & methodology | Links & references |
| Personal observations | Structured frameworks |
| Real-time flow | Polished summaries |

### Phase 1.5: Validate Hand-Note Pages

Before proceeding, verify all pages belong to the same session:

- **Check dates**: If pages show different dates or session labels, confirm with user
- **Check duplicates**: If multiple photos look identical, skip duplicates
- **Check page order**: Use page numbers, timestamps, or content flow to establish correct reading order

**Common pitfall**: A page header may reference a different session number or date (e.g., reusing a notebook page). Do NOT silently remove pages — always confirm with the user if something looks inconsistent.

### Phase 2: Retrieve the Digital Document

Identify the source from user's instruction:

- **Anytype**: `API-list-spaces` → `API-search-space` (by title/topic) → `API-get-object` (with `format: "md"`)
- **Local file**: Glob to find, then Read
- **Other**: Ask user for access method

Read the full content of the digital document.

**If the existing file contains only `![[...]]` embed placeholders** (no extracted text), the file is a skeleton with screenshots waiting to be annotated. Extract text from each embedded image, then combine with hand-notes to create a full annotated note.

### Phase 3: Combine into Unified Note

**Merge strategy**: Use the hand-note **timeline as the skeleton** and embed the digital content into the appropriate time slots.

#### Step 3a: Image Categorization (if document contains images)

If the digital document has embedded images (slides, diagrams, screenshots), **do NOT guess their placement**. Instead:

1. **Download all images** locally: `curl -s -o /tmp/img_01.jpg "<image_url>"`
2. **View each image** using the Read tool to identify its content
3. **Map each image to a timestamp** based on the topic it covers
4. **Note slide text**: Extract key text/data from each slide image to enrich the written notes

For Anytype images, use the gateway URL pattern: `http://127.0.0.1:47800/image/<hash>`

**Why this matters**: Images in digital docs are often unordered or placed arbitrarily. Viewing each one is the only reliable way to categorize them. This step prevents the #1 error in note combination.

#### Step 3b: Build the Combined Document

**Output structure:**

```markdown
## Resource Links
  [All links, references, supplementary materials from digital doc — kept at top for easy access]

---

## Session Notes

### [Timestamp] - [Activity Title]
- [Activity context from hand-notes: who, what format, which group]
- [Detailed knowledge content from digital doc covered at this time]
- [Text extracted from slide images shown at this time]
- [Personal observations from hand-notes]

![[attachments/screenshot.png]]  ← wiki-link format for Obsidian; only images belonging to THIS timestamp

#### [Sub-topic] (use sub-headings when a single timestamp covers multiple distinct topics)
- [Content for sub-topic]

### [Next Timestamp] - [Next Activity]
  ...

---

## Observations
  [Teaching methodology observations, meta-insights about the session format — from hand-notes]
```

**Key principles:**

1. **One flow, not two sections.** Do NOT create separate "hand-note" and "digital note" sections. Produce a single chronological narrative.
2. **Timeline is king.** Every piece of content lives under the timestamp when it was discussed.
3. **Preserve all detail.** Do not summarize or cut content from either source.
4. **Attribute activities to people.** When hand-notes mention who did something, include that context.
5. **Mark unique hand-note additions.** Concepts captured only in hand-notes — bold them so they stand out.
6. **Keep resource links separate.** Links, slides, videos stay in a dedicated section at the top.
7. **Preserve original language.** Do not translate unless the user asks.
8. **Images under correct timestamps.** Each image must be placed under the timestamp where its content was discussed — never distribute images arbitrarily.
9. **Enrich from slide text.** When a slide image contains readable text (definitions, models, references), transcribe key content into the notes above the image.
10. **Use sub-headings for long blocks.** If a timestamp covers multiple distinct topics (e.g., experiments → comparison tables → practical guidelines), use `####` sub-headings within that timestamp.
11. **Remove duplicates.** If the same image hash appears multiple times in the source, include it only once at the most relevant timestamp.
12. **Cite references from slides.** When slide images contain academic citations (author, year, title), include them as text in the notes.
13. **Use wiki-link for Obsidian images.** When the target is an Obsidian vault, embed images with `![[attachments/filename.png]]` syntax — NOT markdown `![alt](path)`. This is the standard Obsidian embed format and resolves correctly within the vault.

### Phase 4: Update the Document

- **Anytype**: `API-update-object` with the combined markdown
- **Local file**: Edit or Write tool
- Confirm the update was successful
- Summarize what was added from hand-notes (brief bullet list for user review)

**Post-update**: If the user reports images are in wrong places, re-enter Phase 3a (download + view each image) to fix categorization. This is the most common correction needed.

## Edge Cases

- **No timestamps in hand-notes**: Use the topic/activity flow as the organizing principle instead
- **Hand-notes span multiple sessions**: Confirm with user which session to merge — do NOT silently remove pages that look like they're from another session
- **Digital document doesn't exist yet**: Create a new document using only hand-note content, structured with timestamps
- **Conflicting information**: Prefer digital doc for factual content (definitions, dates). Prefer hand-notes for experiential content (who said what, activity flow)
- **Ambiguous time format**: 07:15 could be AM or PM — ask user or use context (evening class = 19:15)
- **Duplicate photos**: Skip identical images. Check for near-duplicates (same page, slightly different angle)
- **Large number of images (10+)**: Download and view in batches. Create a mapping table (image → content → timestamp) before writing the combined document
- **Image without clear timestamp match**: Place under the most relevant content section and add a note like "Slide: [topic] — thời điểm trình bày không xác định rõ"

## Handnote-Taking Tips for Users

Share these tips when the user asks how to improve their notes for better AI combination:

| Priority | Tip | Impact |
|----------|-----|--------|
| 1 | **Note slide keywords next to timestamps** (e.g., "19:57 — [eye tracking slide]") | Eliminates image guessing — biggest time saver |
| 2 | **Consistent header on every page**: Session # + date + page number | Prevents wrong-session confusion |
| 3 | **Use 24h time format** (19:15 not 7:15) | Removes AM/PM ambiguity |
| 4 | **Mark topic shifts** within a time block with a line or arrow | Enables sub-section structure |
| 5 | **Delete duplicate photos** before sending | Saves processing time |
| 6 | **Snap 1-2 photos of key slides** with dense text/models | Enriches content directly |
