# AGENTS.md — pi-switch で作業するエージェント向けの指示

読者は pi-switch を変更する AI エージェントと開発者です。利用者向けの仕様は README に、設計の判断基準は DESIGN.md と PHILOSOPHY.md(このプラグイン群共通)に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、下の表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは制約として書かず、自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm run knip` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。下の表の「検証」列は個別の検証箇所であり、自動検証はすべて `verify` に含まれます。

## 制約

### サーフェス

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| モデル向けのツールを登録しない | `test/contract/surface.test.ts` | `src/index.ts` |
| コマンドは `switch` の1つだけ | `test/contract/surface.test.ts` | `test/contract/surface.test.ts` の `EXPECTED_COMMANDS`、`src/index.ts` |
| イベントは `session_start` / `before_agent_start` / `context_with_system` の3種で、各1ハンドラ | `test/contract/surface.test.ts` | `EXPECTED_EVENTS`、`src/index.ts` |
| TUI 以外のモードではピッカーを開かずエラーを通知する | `test/integration/extension.test.ts` | `src/index.ts` の command ハンドラ |

### 設定ファイル

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| パスは user `<agent dir>/pi-switch.json`、project `<cwd>/.pi/pi-switch.json` | `test/unit/config.test.ts` | `src/config.ts` の `userConfigPath` / `projectConfigPath` |
| 適用順は user.disabled → user.enabled → project.disabled → project.enabled。未記載は有効 | `test/unit/config.test.ts` | `src/config.ts` の `resolveConfig` |
| プロンプトセクションはトップレベル `sections` キーだけに置き、`disabled` / `enabled` マップには置かない | `test/unit/config.test.ts` | `src/config.ts` の `parseSections` / `parseLists` |
| `sections` の欠落は空として読む | `test/unit/config.test.ts` | `src/config.ts` の `parseSections` |
| パッケージ指定は由来するツールとスキルすべてに効く | `test/unit/resources.test.ts` | `src/resources.ts` の `itemTarget` / `itemDisabled` |
| npm の source は版を除いて正規化する(`npm:pi-exa@1.2.3` → `npm:pi-exa`) | `test/unit/resources.test.ts` | `src/resources.ts` の `packageKeyFromSource` |
| リストはソートと重複除去で正規化する | `test/unit/config.test.ts` | `src/config.ts` の `normalizeList` |
| 未知のトップレベルフィールドを保存時に保持する | `test/unit/config.test.ts` | `src/config.ts` の `extraFields` / `serializeConfig` |
| 壊れた設定は読み込みを空にして無視する | `test/unit/config.test.ts` | `src/config.ts` の `readConfigFile` |
| 壊れたファイルは上書きせず、トグルを拒否して通知する | `test/unit/config.test.ts` + `test/integration/extension.test.ts` | `src/config.ts` の `writeConfigFile`、`src/index.ts` の `toggle` |
| 壊れた設定の警告はファイルごとに1回だけ出す | `test/integration/extension.test.ts` | `src/index.ts` の `warnMalformed` |
| プロジェクトファイルは trusted のときだけ読み書きする | `test/integration/extension.test.ts` | `src/index.ts` の `reload` / `toggle` |
| 空配列・空オブジェクトは保存時に省略する | `test/unit/config.test.ts` | `src/config.ts` の `compactLists` |
| version は 1 のみ受け付ける | `test/unit/config.test.ts` | `src/config.ts` の `parseConfig` |
| 保存は temp ファイルからの rename で行い、一時ファイルを残さない | `test/unit/config.test.ts` | `src/config.ts` の `writeConfigFile` |

### 適用

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| ツールは起動時の有効集合から無効分を引いた集合を `setActiveTools` で適用する | `test/unit/resources.test.ts` + `test/integration/extension.test.ts` | `src/resources.ts` の `activeToolNames`、`src/index.ts` の `applyTools` |
| カタログに無いツール名はそのまま残す | `test/unit/resources.test.ts` | `src/resources.ts` の `activeToolNames` |
| `exposure: "hidden"` のツールは一覧に出さない | `test/unit/resources.test.ts` | `src/resources.ts` の `collectCatalog` |
| スキルは `before_agent_start` の `systemPromptOptions.skills` をフィルタする | `test/integration/extension.test.ts` | `src/index.ts` の before_agent_start ハンドラ |
| 無効なセクションはリクエスト先頭の system message から除去する | `test/unit/resources.test.ts` + `test/integration/extension.test.ts` | `src/resources.ts` の `filterPromptSections`、`src/index.ts` |
| 無効対象が無ければリクエストを再構築しない | `test/unit/resources.test.ts` | `src/resources.ts` の `filterPromptSections` |
| フィルタ後も先頭 system message の `content` / `toolsAdded` を保持する | `test/unit/resources.test.ts` + `test/integration/extension.test.ts` | `src/resources.ts` の `filterPromptSections` |
| 一覧はビルトイン ∪ 観測済みセクション名 | `test/unit/resources.test.ts` | `src/resources.ts` の `BUILTIN_SECTIONS`、`src/index.ts` の `observedSections` |
| ツールの適用は session_start とトグル時のみ(毎ターン再主張しない) | `test/integration/extension.test.ts` | `src/index.ts` の `applyTools` の呼び出し箇所 |
| 有効集合が変わらないとき `setActiveTools` を呼ばない | `test/integration/extension.test.ts` | `src/index.ts` の `applyTools` |
| トグルは書き込みの前に両ファイルを読み直し、外部編集を保持する | `test/integration/extension.test.ts` | `src/index.ts` の `toggle` |
| Global の有効化が Project の無効化で打ち消されるとき警告する | `test/integration/extension.test.ts` | `src/index.ts` の `notifyIfIneffective` |
| トグルは解決済み設定を更新してから適用する | `test/integration/extension.test.ts` | `src/index.ts` の `toggle` |

### ピッカー

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 行は Packages → Tools → Skills → Sections の順で、空のセクションを出さない | `test/integration/extension.test.ts` | `src/picker.ts` の `view` / `appendSection` |
| 絞り込みは名前・パッケージ名・説明に一致する | `test/integration/extension.test.ts` | `src/picker.ts` の `matchesItem` |
| パッケージ行は実効状態が `on` 以外のとき有効化、`on` のとき無効化する | `test/integration/extension.test.ts` | `src/picker.ts` の `toggleSelected` |
| 未信頼の Project スコープではトグルせず理由を通知する | `test/integration/extension.test.ts` | `src/picker.ts` の `toggleSelected` |
| Esc は絞り込みがあれば消し、無ければ閉じる | `test/integration/extension.test.ts` | `src/picker.ts` の `handleEscape` |
| 複数行の説明文は1行に畳んでから幅で切る | `test/integration/extension.test.ts` | `src/picker.ts` の `singleLine` / `itemLine` |

### 依存関係・import

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin・相対 `.ts`・Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` | 同テストの `ALLOWED_PEER_DEPENDENCIES` |
| 循環依存を作らない | `npx biome check .` | `biome.jsonc` の `noImportCycles` |
| 未宣言の依存を import しない | `npx biome check .` | `biome.jsonc` の `noUndeclaredDependencies` |
| 未使用の export・依存・ファイルを残さない | `npm run knip` | `knip.jsonc` |
| devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` | 同テストの `ALLOWED_DEV_DEPENDENCIES` |

### 配布・ビルド

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 配布物は `files` の whitelist 内のみ | `test/ci/package-contents.test.ts` | `package.json` の `files` |
| `pi.extensions` のエントリが配布物に含まれる | `test/ci/package-contents.test.ts` | `package.json` の `pi.extensions` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

### コード品質

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |

## 変更時の手順

- イベントやコマンドを増減する場合は `test/contract/surface.test.ts` の `EXPECTED_EVENTS` / `EXPECTED_COMMANDS` と期待値を先に更新する。
  1つ落とすと機能が静かに消えるため、契約が変更の入口になる。
- 設定の形式・解決規則・パスを変える場合は `test/unit/config.test.ts` を先に更新し、セマンティクスを固定してから実装する。
  ユーザーに見える振る舞いが変わるため、README の設定節と `docs/adr/` も同じコミットで更新する。
- 適用の規則(適用タイミング、baseline の取り方)を変える場合は `test/integration/extension.test.ts` を先に更新する。
- 依存を追加する場合は devDependency のみ可能。`ALLOWED_DEV_DEPENDENCIES` の更新とコミットメッセージの理由をセットで行う。
  実行時依存(`dependencies`)の追加は不可。
- 決定の記録は `docs/adr/` に置く(1決定 = 1ファイル、`NNNN-<topic>.md`)。追加するのは、却下した代替を再提案されうる決定、機能や振る舞いを削除・置き換える決定、DESIGN.md / PHILOSOPHY.md に触れる決定のときだけ。
  却下案は結果ではなく理由を書く。
- ツール・コマンド・設定・公開の振る舞いを変える前に `docs/adr/` を読み、却下済みの代替を再提案しない。
  決定が変わったら同じコミットで状態を更新する(採用 → 廃止)。
- カバレッジの数値は契約テストの影響を受ける。契約テストは jiti 経由で `src` をもう一度ロードするため、同じファイルが2実体として数えられる。
- ドキュメントの段落内の改行は、文末(。！？)・読点(、)・コロン(:)の直後に置く。

## 手動確認項目(自動検証の対象外)

前提: TUI の Pi セッションで確認する。

1. `/switch` でツールを無効にし、次のターンのモデルのツール一覧から消えること。有効に戻すと復帰すること。
2. スキルを無効にし、システムプロンプトの `<available_skills>` から消えるが `/skill:<name>` は実行できること。
3. パッケージを無効にし、由来ツールとスキルがまとめて消えること。Project の個別有効化で1つだけ戻せること。
4. Global と Project の状態がそれぞれのファイルに保存され、再起動後も維持されること。
5. 未信頼のプロジェクトで Project ファイルが読まれず、書き込みが拒否されること。
6. 壊れた設定ファイルを置いても設定が空になるだけで、ファイルが破壊されないこと。
7. `/switch` の Sections で `docs` を無効にし、次のターンのシステムプロンプトから `<docs>` が消え、セッションファイルには残ること。有効に戻すと復帰すること。
8. 未信頼のプロジェクトで Project ファイルのセクション設定が読まれず、書き込みが拒否されること。
