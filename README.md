# pi-switch

Pi に拡張を入れると、拡張が提供するツールとスキルがモデル向けの一覧に加わります。コンテキストを食い、関係のないスキルが誤発火します。システムプロンプトのセクションも同じくコンテキストを消費し、モデルの振る舞いを誘導します。pi-switch は**モデルへの露出**を、Global（ユーザー全体）と Project（リポジトリ単位）の2スコープで切り替えます。

- 粒度はツール個別・スキル個別・パッケージ一括・プロンプトセクション個別の4つ
- 変更は即時反映（reload 不要）
- 設定は2つの JSON ファイルで、`/switch` の TUI から編集する

```
$ /switch

pi-switch  [Global] Project
filter: type to search
  Packages
  ● npm:pi-exa  2 tools · 1 skill
  Tools
❯ ● exa_search  npm:pi-exa
  ○ exa_request  npm:pi-exa
  Skills
  ○ ui-review  npm:pi-skills
  Sections
  ● docs
  ○ knowledge_index
space toggle · tab scope · esc close        5/8 tools · 3/5 skills
```

## インストール

```bash
pi install git:github.com/kurowashi/pi-switch
```

ref を固定する場合は `pi install git:github.com/kurowashi/pi-switch@<tag|commit>`。

ローカルの作業コピーを使う場合:

```bash
pi install /path/to/pi-switch
```

または直接読み込み:

```bash
pi --extension /path/to/pi-switch/src/index.ts
```

Pi 1.0 以降が必要です。旧版へのフォールバックは持ちません。

## 設定

設定ファイル（後のものが優先）:

| ファイル | 対象 | 読み書きの条件 |
|---|---|---|
| `<agent dir>/pi-switch.json`（通常 `~/.pi/agent/pi-switch.json`） | Global | 常に読み書きする |
| `<cwd>/.pi/pi-switch.json` | Project | 信頼されたプロジェクトのときだけ読み書きする |

`PI_CODING_AGENT_DIR` を設定すると1つ目の場所を変更できます。`.pi` の名前は Pi の `piConfig.configDir` に追従します。

```json
{
  "version": 1,
  "disabled": {
    "packages": ["npm:pi-exa"],
    "skills": ["pdf"]
  },
  "enabled": {
    "tools": ["exa_search"]
  },
  "sections": {
    "disabled": ["docs"]
  }
}
```

コピーして使う場合は [examples/pi-switch.example.json](examples/pi-switch.example.json)。

| キー | 型 | 意味 |
|---|---|---|
| `version` | number | 設定の版。省略時は 1 |
| `disabled.tools` / `.skills` / `.packages` | string[] | 無効にする対象の名前 |
| `enabled.tools` / `.skills` / `.packages` | string[] | 無効化を打ち消して有効に戻す対象の名前 |
| `sections.disabled` / `.enabled` | string[] | 無効／有効にするプロンプトセクション名 |

`disabled` / `enabled` マップが受け付けるのは `tools` / `skills` / `packages` だけです。プロンプトセクションはトップレベルの `sections` キーに置きます。`sections` は省略でき、省略時は `disabled` / `enabled` とも空として扱います。旧版の pi-switch は未知のトップレベルフィールドとしてそのまま保存するため、同じファイルを共有していても既存の設定は壊れません。

対象の名前は次のとおりです。

| 種類 | 名前 |
|---|---|
| ツール | `pi.getAllTools()` が返すツール名（例 `exa_search`） |
| スキル | スキルの `name`（例 `pdf`） |
| パッケージ | `sourceInfo.source`。`npm:` は版を除いて正規化したもの（例 `npm:pi-exa`） |
| プロンプトセクション | `context_with_system` のリクエストに現れたセクション名 |

- `npm:` の `sourceInfo.source`（例 `npm:pi-exa@1.2.3`）は版を除いて `npm:pi-exa` に正規化します。
- `npm:` 以外のソース（`git:` など）は `sourceInfo.source` をそのまま使います。
- コマンドを持たずツールもスキルも出さないパッケージは一覧に出ないため、名前を直接書いても効果はありません。
- プロンプトセクションは名前で指定します。まだ存在しない名前を書いても効果はありません。
- ビルトインの `preamble` / `tools` / `rules` / `docs` / `addendum` / `project_context` / `skills` / `cwd` は、まだ現れていなくても一覧に出ます。
- 観測は無効化の前に行うため、無効化によって送信前に取り除かれた名前も一覧に残ります。

### 解決規則

初期状態はすべて有効です。そこへ次の順で適用します。

1. Global の `disabled` に含まれる → 無効
2. Global の `enabled` に含まれる → 有効
3. Project の `disabled` に含まれる → 無効
4. Project の `enabled` に含まれる → 有効

- どのリストにも無い対象は有効のままです。
- `sections` の `disabled` / `enabled` も同じ順序で解決します（Global の `sections.disabled` → `sections.enabled` → Project の `sections.disabled` → `sections.enabled`）。
- パッケージの指定は、そのパッケージ由来のツールとスキルすべてに効きます。個別の `enabled` はパッケージの `disabled` より後に適用されるため、パッケージ単位で無効にしたうえで1つだけ有効に戻せます。
- 同じ `enabled` の仕組みで、Global で無効にしたものを特定のプロジェクトだけ有効に戻せます。逆に、Project で無効にしたものを Global で有効にはできません。後の層が常に勝ちます。
  - このとき Global ファイルには `enabled` の記録が残り、`g:on` バッジが出ます。このプロジェクトでは無効のままですが、Project が無効にしていない他のプロジェクトでは有効になります。実効状態が無効のままであれば、切り替え時に警告を表示します。
- `version` 以外の未知のトップレベルフィールドは読み飛ばし、保存時にそのまま書き戻します。
- JSON が壊れている、または既知フィールドの型が違うファイルは、警告を1回出して無視し、**上書きしません**。修復するか削除すると、次の読み込みから反映されます。
- 信頼されていないプロジェクトのファイルは読みません。`/switch` の Project スコープは編集できず、理由を表示します。

## 動作

無効化の意味は「モデルへの露出を止める」だけです。

| 対象 | 無効にしたとき | 適用 |
|---|---|---|
| ツール | モデルへの宣言と実行候補から外れる | 次のリクエストから |
| スキル | システムプロンプトのスキル一覧から外れる。`/skill:<name>` の明示実行は残る | 次のリクエストから |
| パッケージ | 由来するツールとスキルをまとめて無効にする | 次のリクエストから |
| プロンプトセクション | モデルへ送るシステムプロンプトからそのセクションが消える。セッションの履歴は変わらない | 次のリクエストから |

- 拡張はアンロードしません。無効にしたパッケージのコマンドは使えます。
- セッションの再読み込みは不要です。`/switch` で切り替えるとその場で反映されます。
- 設定は、セッション開始時、`/switch` を開いたとき、および切り替える直前に読み込みます。手でファイルを編集した場合は `/switch` を開くと反映され、ピッカーを開いている間の外部編集も上書きしません。
- ツールの有効集合の適用は、セッション開始時と切り替え時だけです。他の拡張が後から変えたツールの有効状態を pi-switch は再主張しません。プロンプトセクションは、各リクエストの送信直前にフィルタします。
- ツール・スキル・パッケージの切り替えでは、変更分が transcript のシステムメッセージの差分として積まれます。プロバイダによってはプロンプトキャッシュの一部が無効になり、次の応答が遅く高くつくことがあります。プロンプトセクションの切り替えは transcript を変更せず、送信時だけ反映されます。
- プロンプトセクションは、全拡張がプロンプトを組み立て終えた後のリクエスト直前で取り除きます。transcript には残るため、コンパクションやセッション再開の結果は変わりません。
- セクション一覧は、ビルトインの8セクションと、そのセッションでリクエストに現れた名前（他拡張が注入した `knowledge_index` など）の和集合です。無効化前の観測なので、無効化された名前も一覧に残ります。
- 他の拡張が `systemPrompt` を強制差し替えしている間は、そのプロンプトが優先され、セクションの無効化は効きません。
- 起動時に無効であるツールは、起動時の有効集合から差し引いて適用します。Pi の `defaultTools` や `--tools` の指定はそのまま尊重します。
- カタログにないツール名（セッション開始後に登録されたもの）は、pi-switch の無効化の対象外としてそのまま残します。
- `exposure: "hidden"` のツールは一覧に出しません。Pi がモデルへ宣言しないため、切り替えても意味がないからです。
- スキル名が衝突した場合、Pi が見せる勝者だけが一覧に出ます。pi-switch も名前単位で扱い、衝突の可視化はしません。

## コマンド

| コマンド | 動作 |
|---|---|
| `/switch` | TUI のピッカーを開く。引数は取らない |

TUI モード専用です。print / JSON モードではエラーを表示します。

### キー

| キー | 動作 |
|---|---|
| ↑ / ↓ | 選択を移動する |
| Space / Enter | 選択行を現在のスコープで切り替える |
| Tab | 編集スコープを Global ↔ Project に切り替える |
| 文字入力 | 名前・パッケージ名・説明で絞り込む |
| Backspace / Delete | 絞り込みを1文字削除する |
| Ctrl+U | 絞り込みを消す |
| Esc | 絞り込みを消す。空のときは閉じる |

- パッケージ行は、実効状態が有効なら全リソースを無効にし、一部無効または全無効なら全リソースを有効にします。

### 表示

| 表示 | 意味 |
|---|---|
| `●` / `○` | 実効状態が有効 / 無効 |
| `◐` | パッケージ行: 一部の由来リソースだけが無効 |
| `g:off` / `g:on` | Global ファイルが直接その対象を記録している |
| `p:off` / `p:on` | Project ファイルが直接その対象を記録している |

バッジはファイルの記録、`●`/`○` は全層を適用した実効状態です。パッケージ経由で無効になっている対象にはバッジが付かないことがあります。

## 開発

```bash
npm install          # 依存(すべて devDependency。実行時依存はゼロ)
npm run verify       # 完了条件: biome + tsc + knip + 全テスト + カバレッジ閾値
npm test             # 全テスト
```

検証の内訳・契約テスト・カバレッジ計測・フックの扱いは [AGENTS.md](AGENTS.md) を参照してください。
