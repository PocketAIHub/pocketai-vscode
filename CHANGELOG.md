# Changelog

## 1.0.20

### Fixed

- Reconcile endpoint health, model, and status state immediately when configured endpoints change, preventing removed endpoints from lingering in chat and settings views.
- Restore the complete VS Code 1.127 Extension Host integration test run.

### Changed

- Add repeatable VSIX inspection, packaging, and release-check commands.
- Add CI coverage for type checking, unit tests, Extension Host tests, and VSIX creation.
- Align repository, documentation, and release metadata with the PocketAIHub repository and direct VSIX distribution.
- Pin development API/runtime types to the extension's declared VS Code 1.96 and Node 20 compatibility baseline.
