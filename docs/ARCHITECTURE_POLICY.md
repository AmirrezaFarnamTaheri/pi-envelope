# Opt-in static architecture policies (v0.20.0 candidate)

`envelope_code_policy` evaluates explicit architectural constraints **read-only** over the current source-index import/call graph. It reports observed directory-boundary violations and distinct incoming-file-degree thresholds (potential god nodes). **These are static source facts and heuristics, not formal correctness or runtime behavior.** The function does not write files, and no policy gates run automatically when installing Envelope.

For an explicitly invoked CI gate, add `.envelope/architecture-policy.json` to the source project:

```json
{
  "version": 1,
  "relation": "imports",
  "requireComplete": true,
  "rules": [{ "from": "src/domain/", "forbid": ["src/infra/"] }],
  "maxIncomingFiles": 20
}
```

Then run `npm run architecture:gate` from the **target project's root**, using the Envelope package installation path to call its script where applicable. The script is `node <path-to-pi-envelope>/scripts/architecture-gate.mjs`; it uses only the pinned local TypeScript compiler and the existing CodeIndex, with no provider. Exit codes: `0` when the observed graph passes, `1` on detected violations or incomplete evidence if `requireComplete:true`, and `2` for invalid/unreadable policy input. CI integration is an **explicit user decision**, not silently enforced.

Constraints: 12 boundary rules maximum, 50 displayed violations, 30 visible ranked fan-in entries, 500 incoming-file threshold maximum, bounded CodeIndex (1,000 files). The fan-in list is potentially truncated; results disclose that and fail closed by default. Python/Go static parsing is off in this standalone CLI unless explicitly implemented with a reviewed language configuration. Unindexed code, dynamic imports, untyped receiver calls, generated runtime dependencies and inter-repository edges are not included.

The JSON manifest must be a safe regular file inside a non-symlink `.envelope` directory; malformed or unknown fields fail closed. Tests in `tests/architecture-policy.test.mjs` cover observed violations, clean results, incomplete evidence, validation and actual process exit codes.
