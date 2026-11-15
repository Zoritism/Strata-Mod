# Strata-Mod

- Author: Zoritism. Preserve upstream and third-party copyright notices.
- Read AGENTS.local.md when present. Do not publish local paths, keys, profiles, logs, backups, chats or generated media.
- The supplied packages are folder-paths, chat-rules and strata-ui. Their shared runtime is in runtime/core; upstream integration stays in narrow bridges. Upstream Strata and installed applications remain separate.
- The audited upstream is Strata 0.2.13, commit d2f096475817d4666c364c820b0ca830f751cfc5. Keep scripts/bridge.mjs and bridges/upstream-v0.2.13.patch consistent. New upstream versions require a fresh source and compiled-bundle audit.
- Keep behavior outside upstream. Use short hooks and exact verified anchors; do not maintain a fork of the native UI or model loop.
- Own state by subject: folder-paths owns storage configuration, chat-rules owns per-chat instructions, strata-ui owns computer indicators, mobile layout, file disclosures and LAN controls. Document those supplied contracts and keep implementations with their owner.
- Never replace native profiles or move models implicitly. Preserve unknown user fields. Data migration is a separate operation with source/destination verification.
- Update only the selected, closed installation. Do not terminate unrelated applications. Warn before installing or downloading tools; prefer the existing Node and Windows compiler.
- Use scripts/overlay-install.mjs for installation, preflight and guarded rollback. Verify all planned inputs before modifying files; retain the backup until acceptance.
- Use synthetic fixtures under .work for tests. Run focused Node tests for persistence, migration, native hooks and install/rollback. After browser import changes, verify the full public UI import graph through HTTP.
- Explain nontrivial algorithms, ownership and lifecycle boundaries in nearby comments. Keep changes scoped; do not rewrite unrelated accepted behavior.
- Before publication review staged paths and diffs. Documentation describes supplied behavior and portable requirements, without personal environment details or development-session history. No upstream checkout, downloaded tools, models, user data, local inventory or generated binary belongs in this repository.
