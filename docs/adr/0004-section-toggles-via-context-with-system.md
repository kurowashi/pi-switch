# プロンプトセクションの切替は context_with_system で行う

- 状態: 採用
- 日付: 2026-10-05
- 対象: `/switch` のプロンプトセクション切替と、設定ファイルのトップレベル `sections` キー

## 背景

ツール・スキル・パッケージに加えて、システムプロンプトのセクション（`docs`、`project_context`、他拡張が注入する `knowledge_index` など）もモデルへの露出です。
セクションは Pi がプロンプトを組み立てる過程で生成されるため、`before_agent_start` の `systemPromptOptions` からは Pi ビルトインの `rules` / `docs` / `cwd` を除去できません。
`forceSystemPrompt` による差し替えはハンドラ順序に依存し、他拡張（pi-spawn など）の強制プロンプトと競合します。

## 決定

全拡張がプロンプトを組み立て終えた後のリクエスト直前（`context_with_system`）で、マージ済みの system メッセージから無効なセクションを取り除きます。
transcript には完全なセクションを残します。

設定は既存の `disabled` / `enabled` マップではなく、トップレベル `sections` キーに `{ disabled: string[], enabled: string[] }` として置きます。

## 理由

- `context_with_system` は Pi が全拡張の変更をマージした後に発火するため、ハンドラ順序に依存せず、他拡張のセクションも一様に扱えます。
- 無効化は各リクエストにだけ適用し、transcript を書き換えません。compaction・セッション再開・再有効化が無効化の影響を受けません。
- トップレベル `sections` は、旧版の pi-switch が未知のトップレベルフィールドとして保存します。Project の設定ファイルを共有していても、旧版は既存のツール・スキル・パッケージ設定を壊しません。

## 帰結

- 他の拡張が `systemPrompt` を強制差し替えしている間は、そのプロンプトが優先され、セクションの無効化は効きません（README に明記）。
- セクション一覧はビルトインの8セクションと、そのセッションでリクエストに現れた名前の和集合になります。

## 代替案

| 代替 | 結果 |
|---|---|
| `customPrompt` の再構築 | 却下 |
| `forceSystemPrompt` の返却 | 却下 |
| `systemPromptOptions.sections` の空文字上書き | 却下 |
| `disabled.sections` / `enabled.sections` への配置 | 却下 |

### 却下理由

- `customPrompt` の再構築: ビルトインの `docs` / `rules` / `cwd` を個別に除去できず、除去には独自プロンプトの再構築が必要になります。
- `forceSystemPrompt` の返却: ハンドラ順序に依存して他拡張のセクションを落とし、他拡張の強制プロンプトと競合します。
- `systemPromptOptions.sections` の空文字上書き: 空文字は無視され、ビルトインセクションは残ります。
- `disabled.sections` / `enabled.sections` への配置: 旧版は未知のキーとしてファイル全体を malformed 扱いし、既存の設定も無効になります。
