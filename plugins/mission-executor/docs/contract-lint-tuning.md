# Tuning `contract-lint.mjs`

The Phase 0.5 contract lint has four filters layered to drop noise while
keeping real contradictions. When a mission surfaces unexpected false
positives or misses a known contradiction, tune in this order:

1. **`GENERIC_WORDS` stoplist** in `scripts/contract-lint.mjs`. Add
   domain-generic backtick tokens (new HTTP verbs, common type names) that
   match too many AGENTS.md entries. Also add new tool-type tokens if the
   contract vocabulary grows.
2. **External-code directories** in `walkAgentsMd`'s skip set. Add
   directories that contain reference or mirror AGENTS.md files that do
   not govern the project under test (e.g. `.discovery/<lib>/`,
   `research/`, `third_party/`).
3. **`SUSPECT_PHRASES`**. Negations and trust-model flags that signal
   "this behavior is intentionally excluded from the contract's apparent
   demand." Add more roots if the contract surfaces new patterns
   (`opt-out`, `declined`, `deferred`).
4. **`ALIGN_ROOTS`** in `findContradictions`. When the assertion body
   contains any of these roots, the assertion is affirming (not
   contradicting) the AGENTS.md. Widen when assertions start using new
   synonymous phrasing.

The cross-paragraph filter (`\n\s*\n` between keyword and phrase) and
the sentence-window (±150 chars) are structural and should not need
tuning.
