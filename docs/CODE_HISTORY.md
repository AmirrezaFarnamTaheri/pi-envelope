# Bounded Git history evidence (v0.19.0 review candidate)

`envelope_code_history` projects only existing **Git metadata** over the files in the already refreshed `CodeIndex`. It never modifies the repository, executes indexed source or installs a separate graph database.

- `status`: count historical non-merge commits, changed indexed files and known limits.
- `cochange`: for an indexed source `path`, count commits in which it and another indexed source appeared together. Co-change does **not** imply dependency, ownership, functional coupling or causality.
- `churn`: count times an indexed source changed in the bounded history window. Not complexity or code-quality proof.

Queries examine at most 100 non-merge commits; the default is 60. A single commit touching more than 40 indexed files is skipped with an explicit `large-commit-omitted` reason rather than distorting co-change counts. At most 20 results are returned. Git subprocesses use fixed argv, no shell, a 4-second timeout and a 512 KiB stdout budget. The current Git root must equal the real project root; tracked files are filtered through the index. No author name, email, full Git commit messages or source contents are returned.

A window cap produces `complete:false` and `history-window-limit`. If Git is missing/unavailable or the cwd belongs to an unrelated parent repository, return `available:false`, never an empty result claimed complete. The `cochange` relationship is historical metadata, **not** a source-evidence edge in `envelope_code_graph` and is never substituted for static imports or call resolution.

This is a partial native adaptation of co-change exploration patterns in CodeGraph, ops-codegraph-tool and TeaRAGs, not a replacement for their full temporal engines, semantic clustering or architecture CI policies. Tests: `tests/code-history.test.mjs`.
