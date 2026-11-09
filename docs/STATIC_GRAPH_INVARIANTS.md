# Checkable static graph invariants (review candidate)

This is a deliberately **small formal graph-property checker**, independently composed on Envelope's existing, SHA-256-verified `CodeIndex`. It can verify properties of the currently indexed directed **file import graph**. It is not a proof of program semantics, dataflow safety, type checking, termination, information flow, runtime dependency behavior, or equivalence to AxiomCodeGraph's formal IR.

## Read-only `envelope_code_invariant`

```json
{"action":"acyclic","maxNodes":200,"maxChars":4000}
{"action":"reach","source":"src/a.ts","target":"src/b.ts"}
{"action":"no-path","source":"src/a.ts","target":"src/b.ts"}
```

The engine verifies each source file's current SHA-256 against CodeIndex before using its statically resolved import edges. `acyclic` produces a deterministic dependency-before-importer topological ordering when no cycle is found, or a directed cycle witness `[A,B,...,A]` when violated. `reach` returns the exact sequence of indexed import edges from source to target if a path exists; `no-path` returns the complete sorted set explored from the source when the target is absent. An independent `checkGraphCertificate` function validates cycle, ordering and path/closure certificates against the current graph and version.

The output has `verdict: "holds" | "violated" | "unknown"`, `complete`, `reasons`, and a content-derived graph `version`. The checker says **unknown**, not proved, when the parser reports unavailable coverage, the source-index file cap may have been hit, a graph-node cap is exceeded or a certificate cannot fit the output budget. Source mutation since the index refresh or unsafe symlinks fail closed. A witnessed cycle or path remains verifiable even with incomplete other portions of the graph, but **absence** of a path cannot be affirmed from incomplete evidence.

Bounds: 1–500 graph files per call, 24 MiB source verification, 900–16,000 serialized JSON output bytes. No model provider, external tool runtime, file writes, GraphQL/MCP server, or separate parser/index/hook is created. The checker makes no complexity, performance, security, cost or code-quality guarantees.

## Distinction from formal program verification

A successful topological certificate only proves that the inspected **static import edge set** is acyclic. It does not prove there are no dynamic imports, no runtime cycles, no side effects, or that the program is correct. More complete formal-methods integration would require source-language typing, precise IR, explicit axioms, contracts, proof obligations, soundness arguments and independent counterexample tests over the supported languages. Those are **not** present here; [tracker #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10) keeps them open. This is a narrow adaptation of the checkable-evidence principle in [AxiomCodeGraph](https://github.com/AxiomCodeAI/axiomcodegraph) and SDL/CodeGraph structure analysis.

Verification: `tests/graph-invariants.test.mjs` checks deterministic topological order, real cycle/path witnesses, independent tampering detection, absent path closure, unknown on missing coverage, source freshness, root restrictions, output budgets and single-Pi-tool registration.
