# Knowledge Hub Gather

Ingest new learning inputs from configured channels.

## Sources

- YouTube queue
- RSS feeds
- Podcast feeds
- Recent system/session artifacts

## Workflow

1. Collect new items only (avoid reprocessing known entries).
2. Normalize each item into a compact note: source, topic, key takeaway, confidence.
3. Mark operational anomalies found during ingestion.

## Output

Create an ingestion report in deployment workspace with processed items, skipped items, and anomalies.
