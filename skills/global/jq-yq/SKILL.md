---
name: jq-yq
description: >
  This skill should be used when working with JSON or YAML data files. Provides
  jq and yq command references for querying, filtering, transforming, and converting
  between JSON and YAML formats.
pa-tier: 2
pa-inject-as: shared-skill
source: /home/sinh/.claude/skills/jq-yq/SKILL.md
---

# jq & yq CLI Reference

Use jq for JSON manipulation and yq for YAML manipulation. Both support similar
syntax for querying, filtering, and transforming data.

## jq — JSON Processor

### Basic Syntax

```bash
jq '<filter>' file.json          # Process file
echo '$json' | jq '<filter>'     # Process string
jq -s '.' *.json                 # Merge multiple files into array
```

### Common Filters

| Filter | Purpose | Example |
|--------|---------|---------|
| `.` | Identity (output as-is) | `jq '.' data.json` |
| `.key` | Select key | `jq '.name' data.json` |
| `.key1.key2` | Nested select | `jq '.user.address.city' data.json` |
| `.[0]` | Array index | `jq '.[0]' data.json` |
| `.[].name` | All items, select key | `jq '.[].name' data.json` |
| `.[] \| select(.x > 5)` | Filter array | `jq '.items[] \| select(.price > 100)' data.json` |
| `.key \| length` | Array/object length | `jq '.items \| length' data.json` |
| `keys` | Object keys | `jq 'keys' data.json` |
| `has("key")` | Check key exists | `jq 'has("name")' data.json` |

### Transformations

```bash
# Map/transform
jq '[.items[] \| {id: .id, value: (.price * .qty)}]' data.json

# Add computed field
jq '.items[] \| .total = (.price * .qty)' data.json

# Delete key
jq 'del(.password)' data.json

# Rename keys
jq 'with_entries(.key \|= sub("^old"; "new"))' data.json

# Merge objects
jq '.a + .b' data.json

# Conditional
jq 'map(select(.status == "active"))' data.json
```

### Output Formats

```bash
jq -c           # Compact (no whitespace)
jq -r           # Raw output (no quotes)
jq -r '.[]'     # Raw output from array
jq -M           # Monochrome (no colors)
jq -n           # Null input (use with expressions)
jq -e           # Exit with 1 on null/undefined output
jq -s           # Wrap result in array
```

### Update In-Place (requires jq 1.6+)

```bash
jq '.<filter>' file.json > tmp.json && mv tmp.json file.json
# Or use sponge
jq '.<filter>' file.json | sponge file.json
```

---

## yq — YAML Processor

### Basic Syntax

```bash
yq '<filter>' file.yaml          # Process file
yq -y '<filter>' file.yaml       # Output as YAML (default)
yq -j '<filter>' file.yaml       # Output as JSON
yq -r '<filter>' file.yaml       # Raw output
```

### Common Filters

| Filter | Purpose | Example |
|--------|---------|---------|
| `.` | Identity | `yq '.' data.yaml` |
| `.key` | Select key | `yq '.name' data.yaml` |
| `.key1.key2` | Nested select | `yq '.user.address.city' data.yaml` |
| `.[0]` | Array index | `yq '.[0]' data.yaml` |
| `.[].name` | All items, select key | `yq '.[].name' data.yaml` |
| `.[] \| select(.x > 5)` | Filter array | `yq '.items[] \| select(.price > 100)' data.yaml` |
| `keys` | Object keys | `yq 'keys' data.yaml` |
| `has("key")` | Check key exists | `yq 'has("name")' data.yaml` |

### Transformations

```bash
# Map/transform
yq '.items[] \| {id: .id, value: (.price * .qty)}' data.yaml

# Add computed field
yq '.items[] \| .total = (.price * .qty)' data.yaml

# Delete key
yq 'del(.password)' data.yaml

# Rename keys
yq 'with_entries(.key \|= sub("^old"; "new"))' data.yaml

# Merge YAML documents
yq 'sort_keys' data.yaml
```

### Write Back

```bash
# Update in place
yq -i '.<filter>' file.yaml
```

---

## Converting Between Formats

```bash
# JSON to YAML
cat data.json | yq -y '.'

# YAML to JSON
cat data.yaml | yq -j '.'

# JSON to YAML (file)
jq -r '.' data.json | yq -y '.'

# YAML to JSON (file)
yq -j '.' data.yaml > data.json
```

---

## Practical Examples

### Extract specific fields from JSON

```bash
# Get all ticket titles
jq '.tickets[].title' data.json

# Get unique values
jq '[.[].status] \| unique' data.json

# Count items
jq '[.items[] \| select(.active == true)] \| length' data.json
```

### Merge JSON files

```bash
# Merge objects (last wins on conflict)
jq -s 'reduce .[] as $item ({}; . * $item)' file1.json file2.json

# Combine into array
jq -s '.' file1.json file2.json
```

### Validate JSON/YAML

```bash
# Validate JSON
jq '.' data.json > /dev/null && echo "Valid JSON"

# Validate YAML
yq '.' data.yaml > /dev/null && echo "Valid YAML"
```

### Pretty print

```bash
# JSON pretty print
jq '.' data.json

# YAML pretty print
yq '.' data.yaml
```

### Extract from nested structures

```bash
# All values of a key regardless of nesting
jq '.. \| objects \| select(has("id")) \| .id' data.json

# Flatten nested array
jq '.. \| arrays \| @json' data.json
```

### Filter and project

```bash
# Get items where status=active, only name and email
jq '.users[] \| select(.status == "active") \| {name, email}' data.json
```

### Sort by key

```bash
# Sort array of objects by specific key
jq 'sort_by(.timestamp)' data.json

# Sort object keys
jq 'sort_keys' data.json
```

### Group and aggregate

```bash
# Group by field
jq 'group_by(.category)' data.json

# Count by status
jq 'group_by(.status) \| map({status: .[0].status, count: length})' data.json
```

---

## Tips

- Use `jq -c` for compact output in scripts
- Use `jq -r` when you need raw strings (no quotes)
- yq's default output is YAML; use `-j` for JSON output
- Both tools support update-in-place with `-i` flag (jq 1.6+, yq)
- Use `sponge` for atomic writes: `jq '.' file.json | sponge file.json`
