# AGENTS.md — pi-switch

読者: pi-switch を変更するエージェントと開発者。利用者向けの仕様は README、設計判断は DESIGN.md。
共通の検証と規則はルートの `AGENTS.md` にある。

## 壊してはいけない制約

- モデル向けのツールを登録しない。コマンドは `switch` の1つだけ。イベントは `session_start` / `before_agent_start` / `context_with_system` の3種で各1ハンドラ（`test/contract/surface.test.ts`）。
- 設定ファイルは user が `<agent dir>/pi-switch.json`、project が `<cwd>/.pi/pi-switch.json`。project は trust 済みのときだけ読み書きする。`version` は 1 のみ（`test/unit/config.test.ts`）。
- 適用順は `user.disabled` → `user.enabled` → `project.disabled` → `project.enabled`。未記載は有効。`sections` はトップレベルキーだけに置く（`test/unit/config.test.ts`）。
- 保存は temp ファイルからの rename で行い、一時ファイルを残さない。保存時は未知のトップレベルフィールドを保持する。壊れたファイルは上書きせず、トグルを拒否して通知する（`test/unit/config.test.ts`）。
- トグルは書き込みの前に両ファイルを読み直し、外部編集を保持する（`test/unit/config.test.ts`）。
- ツールは現在の有効集合から無効分を外して適用する。無効化で外した名前は hidden として保持し、有効化で復元する。hidden に入るのは `direct` / `model-only` の無効ツールだけ（`test/integration/extension.test.ts`）。
- 有効集合が変わらないとき `setActiveTools` を呼ばない。ツールの適用は `session_start`・トグル時・登録ツールの変化を検知した `before_agent_start` のみ（`test/integration/extension.test.ts`）。
- スキルは `before_agent_start` の `systemPromptOptions.skills` をフィルタする。プロンプトセクションは `context_with_system` で、無効なセクションだけを先頭 system message から除去する（`test/integration/extension.test.ts`）。
- TUI 以外のモードではピッカーを開かず、エラーを通知する（`test/integration/extension.test.ts`）。
- 実行時依存を持たない。配布は `files` の範囲内で、`pi.extensions` のエントリを含む（`test/contract/dependencies.test.ts`、`test/ci/package-contents.test.ts`）。

## 変更手順

- イベントやコマンドを増減するときは、`test/contract/surface.test.ts` の `EXPECTED_EVENTS` / `EXPECTED_COMMANDS` を先に更新する。
- 設定の形式・解決規則・パスを変えるときは、`test/unit/config.test.ts` を先に更新してセマンティクスを固定する。ユーザーに見える振る舞いが変わるため、README の設定節と `docs/adr/` も同じコミットで更新する。
- 適用の規則（適用タイミング、baseline の取り方）を変えるときは、`test/integration/extension.test.ts` を先に更新する。
- ツール・コマンド・設定・公開の振る舞いを変える前に、関係する `docs/adr/` を読む。
- 手動で確認する項目は [docs/manual-checks.md](docs/manual-checks.md) に書く。
