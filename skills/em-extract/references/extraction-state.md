# Extraction State Reference

Use this reference when `em-extract` updates an existing event model or when the
user asks for repeatable extraction from a changing codebase. The state file is
a checkpoint and provenance record, not the source of truth. The YAML model
remains the source of truth for domain decisions.

## Location

Write extraction state to:

```text
.event-modeling/extraction-state.json
```

Keep the file deterministic and human-readable: two-space indentation, stable
object key ordering where practical, and repository-relative paths.

## Why state is needed

A commit hash alone only says the repository changed. Incremental extraction
needs enough provenance to answer which model artifacts are affected and whether
the existing YAML was manually edited after the last extraction.

Track all three layers when available:

- Git checkpoint: current commit and tree identify the source revision.
- Evidence hashes: knowledge graph and source file hashes identify uncommitted
  or regenerated input changes.
- Model hashes and provenance: existing YAML changes and source-to-artifact
  links help preserve human edits.

## Schema

The file is JSON with this shape:

```json
{
  "version": 1,
  "updatedAt": "2026-06-25T00:00:00.000Z",
  "source": {
    "type": "understand-anything",
    "gitCommit": "abc123",
    "gitTree": "def456",
    "knowledgeGraphPath": ".understand-anything/knowledge-graph.json",
    "knowledgeGraphSha256": "...",
    "scannedPaths": {
      "src/billing/startSubscription.ts": "sha256..."
    }
  },
  "model": {
    "configPath": ".event-modeling/config.yaml",
    "fileHashes": {
      "event-model/events.yaml": "sha256...",
      "src/features/billing/start-subscription/start-subscription.slice.yaml": "sha256..."
    }
  },
  "provenance": {
    "StartSubscription": {
      "artifactType": "slice",
      "artifactPath": "src/features/billing/start-subscription/start-subscription.slice.yaml",
      "evidence": [
        {
          "kind": "source-file",
          "path": "src/billing/startSubscription.ts",
          "selector": "function startSubscription",
          "sha256": "..."
        },
        {
          "kind": "knowledge-graph-node",
          "path": ".understand-anything/knowledge-graph.json",
          "selector": "node:StartSubscription",
          "sha256": "..."
        }
      ],
      "lastSeenAt": "2026-06-25T00:00:00.000Z",
      "confidence": "confirmed"
    }
  }
}
```

Required top-level fields:

| Field | Type | Notes |
|---|---|---|
| `version` | number | Start at `1`. |
| `updatedAt` | string | ISO-8601 timestamp for the extraction write. |
| `source` | object | Current evidence checkpoint. |
| `model` | object | Hashes for model files after a successful write. |
| `provenance` | object | Artifact-to-evidence links keyed by stable artifact name. |

## Source fields

Use `source.type` values:

| Value | Meaning |
|---|---|
| `understand-anything` | Extraction primarily used `.understand-anything/knowledge-graph.json`. |
| `codebase` | Extraction primarily used direct source inspection. |
| `mixed` | Both graph and direct code inspection materially informed the result. |

Populate Git fields only when the repository has them:

- `gitCommit`: output of `git rev-parse HEAD`
- `gitTree`: output of `git rev-parse HEAD^{tree}`

If the worktree is dirty, still record the Git fields, but also record hashes for
the graph and every source file that materially informed the extraction. This
lets future runs detect changes that are not represented by the commit hash.

## Provenance keys

Use stable, human-readable keys that correspond to model concepts:

- Slice names for slice provenance, such as `StartSubscription`
- Event names for registry-only event provenance, such as `SubscriptionStarted`
- Query or command names only when they need independent provenance

Each provenance entry should include:

| Field | Type | Notes |
|---|---|---|
| `artifactType` | string | `slice`, `event`, `story`, `command`, or `query`. |
| `artifactPath` | string | Repository-relative path to the owning YAML file. |
| `evidence` | array | Source file or graph-node references. |
| `lastSeenAt` | string | ISO timestamp from the most recent extraction where evidence was found. |
| `confidence` | string | `confirmed`, `inferred`, or `question`. |

## Incremental comparison

On each incremental run:

1. Hash the current knowledge graph if present.
2. Hash source files that materially inform extraction.
3. Hash existing event-model YAML before editing.
4. Compare current evidence with prior `provenance`.
5. Classify proposed changes as `add`, `update`, `stale`, or `conflict`.
6. After confirmed writes, hash the resulting model files and write the updated
   state.

Treat a model file hash mismatch as a signal that the YAML changed since the
last extraction. Read the changed file and preserve the user's modeling choice
unless current evidence clearly shows the model is wrong.

## Stale artifacts

Do not delete stale artifacts automatically. A missing source reference can mean
the code moved, the graph omitted an edge, or the model intentionally describes
target behavior not yet implemented. Report stale artifacts with evidence and a
recommendation, then wait for confirmation before deleting or rewriting them.
