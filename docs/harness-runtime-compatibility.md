# DeepSeek Harness runtime compatibility

The regular CI matrix checks this package on Node.js 22, 24 and 26 across
Linux, macOS and Windows. That validates the plugin's own runtime surface; it
does not prove that the plugin composes with real DeepSeek Harness Host APIs.

The separate `harness-compatibility` workflow mounts the production
Translation Pane `apply()` function into a real Cordis context, with the real
AgentLoop and AgentLoop testkit packages from two immutable Harness release
commits:

| Harness release | Immutable commit |
|---|---|
| `dsh-v0.2.2-rc.4` | `3f321d32bfe382212a8ed8785c1d47a5a300aa23` |
| `dsh-v0.2.2-rc.5` | `9c2670d3bce5275e0d1610272958121af87787bb` |

Both revisions expose the same workspace paths for Cordis, AgentLoop and its
testkit. The workflow installs and builds each exact Harness revision with
Node.js 24.9.0 and pnpm 11.28.5, then runs the package unit suite and a runtime
smoke test.

## Runtime contract exercised

For each Harness revision, the smoke test verifies:

1. The real Cordis context can mount the real AgentLoop test dependencies.
2. The production plugin can register its service and tool against the actual
   Host context, without a fake Cordis context.
3. The Typert Remote method descriptor remains version 1 and exposes
   `describe` and `translate`.
4. JSON mode sends only decoded string values to the mocked provider while
   preserving the original document layout and non-string values.
5. Invalid JSON is rejected before any provider request.

The provider is mocked deliberately: this is a runtime/API compatibility test,
not an external translation-service availability test. The workflow emits one
machine-readable `harness-compatibility.json` artifact per Harness revision.
A passing result establishes compatibility only with the exact pinned
revisions and exercised contract; it does not claim compatibility with every
Harness release or a full desktop/web application boot.
