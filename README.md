# ego-lite MCP サーバ

Claude Desktop から ego (lite) ブラウザを操作するための MCP サーバ。
`ego-browser` CLI を子プロセスとして起動し、JavaScript を渡して実行させる。

## 用語

- **ego (lite)**: Chromium ベースのブラウザ。AI エージェントに、利用者自身のログイン済みセッションを共有させることを目的とする。ローカル実行、配布は macOS 向けのみ。
- **MCP (Model Context Protocol)**: AI クライアントが外部ツールを呼び出すための通信規約。Claude Desktop はこの規約でローカルのサーバプロセスを子プロセスとして起動し、標準入出力で通信する。
- **skill**: エージェントに手順を与える形式。実行そのものは行わず、エージェント側の実行手段（シェル等）に依存する。

## なぜ必要か

ego lite 公式が配布している `ego-browser` は skill 形式だが、中身はシェルコマンドの実行手順である。
公式が対応エージェントとして挙げているのは Claude Code・Codex・Cursor など、いずれもローカルでシェルを実行できる CLI エージェントである。
Claude Desktop 単体にはシェル実行の経路がないため、skill を入れても実行段が存在しない。
この欠けている実行段を埋めるのが、この MCP サーバの役割である。

ego lite の制御は `ego-browser` に JavaScript を渡す形になっているため、CDP (Chrome DevTools Protocol) を自前で喋る必要はない。
CLI を起動するだけの薄いサーバで成立する。

## 必要なもの

- ego lite.app（起動していること）
- `ego-browser` CLI
- Node.js（サーバ自体の実行用。スクリプトは ego-browser 組み込みの Node で動く）

## ファイル構成

| ファイル | 役割 |
|---|---|
| `server.mjs` | MCP サーバ本体 |
| `test.mjs` | 標準入出力越しの疎通確認 |
| `ego-browser-skill` | `~/.agents/skills/ego-browser` へのシンボリックリンク（複製ではない） |

## 導入

リポジトリを取得したディレクトリで依存パッケージを入れる。

```
npm install
```

Claude Desktop の設定ファイル `claude_desktop_config.json` の `mcpServers` に、次の項目を加える。
設定ファイルは、macOS では通常 `~/Library/Application Support/Claude/claude_desktop_config.json` にある。

```json
"ego-lite": {
  "command": "node",
  "args": ["/path/to/ego-lite/server.mjs"],
  "env": { "EGO_BROWSER_BIN": "/path/to/ego-browser" }
}
```

2 つのパスは、自分の環境の絶対パスに置き換える。
JSON の中では `~` や `$HOME` が展開されないため、省略形は使えない。

- `args`：このリポジトリの `server.mjs`。リポジトリのディレクトリで `echo "$PWD/server.mjs"` を実行すると得られる
- `EGO_BROWSER_BIN`：`ego-browser` CLI。`command -v ego-browser` で得られる（ego lite のオンボーディング後は通常 `~/.local/bin/ego-browser`）

`EGO_BROWSER_BIN` は必須に近い。Claude Desktop から起動される子プロセスは、ログインシェルの環境変数を引き継がない。
`ego-browser` が PATH 上で見つからない可能性が高いため、絶対パスを環境変数で渡す。
未設定の場合は `ego-browser` を PATH から探し、見つからなければその旨とこの環境変数名を返す。

設定ファイルを書き換えたあと、**Claude Desktop を再起動する**。起動中のプロセスには反映されない。

## 動作確認

リポジトリのディレクトリで、シェルから標準入出力越しの疎通を確認する。

```
EGO_BROWSER_BIN="$(command -v ego-browser)" node test.mjs
```

`initialize`、`tools/list`、`tools/call`（成功時と例外送出時）を順に検査し、
問題がなければ `all checks passed` と出る。

Claude Desktop 側では、2 段階で確認する。順番に意味がある。

第 1 段階。`ego_run_script` を次の内容で呼ぶ。

```js
console.log(await help("taskSpace"))
```

ブラウザ本体には接続せず、サーバの起動・`ego-browser` の発見・ツールの受け渡しだけを確かめる。

第 2 段階。

```js
const task = await taskSpace("smoke test");
const page = task.page("p1");
await page.goto("https://example.com");
console.log(task.spaceId, await page.snapshot());
await task.finish({ keep: [] });
```

第 1 段階が通って第 2 段階で `Failed to connect to ego_cli bootstrap` が返った場合、
原因は「Claude Desktop が子プロセスを起動する環境から ego lite の内部サービスに届かない」に絞られる。

2026-09-16 に両段階とも成功することを確認した。
デスクトップアプリが起動した子プロセスから ego lite の内部サービスに到達できており、
懸念していたサンドボックスの制約には当たらなかった。
第 2 段階では example.com を開き、スナップショットを取得し、`finish({ keep: [] })` でタスクスペースを閉じるところまで通っている。

## 設計

### ツールは `ego_run_script` の 1 本のみ

JavaScript のソース文字列を受け取り、そのまま `ego-browser nodejs` の標準入力へ流し、`console.log()` の出力を返す。

操作ごとにツールを分ける案（`ego_navigate`、`ego_click`、`ego_snapshot` など）は採らなかった。
1 操作ごとにプロセス起動のオーバーヘッドが乗るうえ、ego lite の設計思想は
「複数操作をまとめた 1 本のスクリプトを一度に流す」ことなので、速度面で逆行する。

### API の説明をこのサーバに書き写さない

ツールを 1 本にする構成の欠点は、本来なら「ヘルパー一覧と使い方をツールの説明文に全て書き込む必要がある」ことにある。
しかし ego-browser の実行環境には `help()` が組み込まれており、API の説明文を実行時に返すため、この欠点は成立しない。

```
$ ego-browser nodejs -e 'console.log(await help())'             # 全 API、14,603 文字
$ ego-browser nodejs -e 'console.log(await help("taskSpace"))'  # 1 項目のみ
```

ツールの説明文には `await help()` を呼ぶよう指示するだけでよい。
本体が `ego-browser upgrade` で新しくなれば、返る内容も自動的に新しくなる。

**この方針を採った理由は、書き写しによる食い違いを一度起こしたためである。**
2026-09-14 時点の検討メモは、公式サイト（https://lite.ego.app/document/en/docs/ego-browser）の記述から
`useOrCreateTaskSpace()` / `openOrReuseTab()` / `snapshotText()` / `cliLog()` という API 一覧を書き写していた。
実際にインストールされていた ego-browser（公式スキル文書は version 2.0.0、2026-09-09 付）の API は
`taskSpace()` / `task.page()` / `page.goto()` / `page.snapshot()` / `console.log()` であり、一致しなかった。
名前が違うだけでなく、実物はページ単位の操作、ポップアップとダイアログの受領情報、ファイルのダウンロード、
ユーザーへの操作権の受け渡し（`handOff()`）まで含む。

運用上の約束事（1 ゴールにつき 1 タスクスペース、観測は必要最小限、完了時の `finish({ keep: [] })` など）は
`help()` には含まれず、`~/.agents/skills/ego-browser/SKILL.md` にのみある。
これも複製せず、スクリプト内から `node:fs/promises` で読み出す形をツールの説明文で案内している。
リポジトリ内の `ego-browser-skill` は、このディレクトリへのシンボリックリンクである。

### 危険操作の扱い

ログイン済みセッションをそのまま使う設計のため、送信・購入・削除に相当する操作が実行可能である。
これをサーバ側では止めない。
Claude Desktop はツール呼び出しの前に承認画面を出し、そこには実行されるスクリプトの全文が表示されるため、
利用者が読んでから許可できる。

サーバ側で語句を検査して拒否する案（「送信」「Send」「購入」などを含んだら拒否する）は採らなかった。
要素番号（`@21` など）での指定に対して無力である一方、
「送信ボタンを探す」だけの安全なスクリプトも誤って拒否するためである。

**この方針は `ego_run_script` を「常に許可」に設定しないことが前提である。** 設定した時点で歯止めがなくなる。
日常の調べ物で「常に許可」にしたくなった場合は、読み取り専用のツール
（URL を受け取ってページ内容を返すだけの固定処理）を別に立て、そちらだけを「常に許可」にする。
これが次の一手として残してある判断である。

### タイムアウトと出力量

実行時間の上限を 180 秒、出力の上限を 100,000 文字とした。
上限に達した場合は、切り詰めた旨と、出力を絞る具体的な手段
（`snapshot({ scope: "subtree", root: "@N" })` など）を末尾に付ける。

### 出力の経路

ego-browser の埋め込み Node は、`console.log()` の出力を標準出力ではなく標準エラー出力に書く。
成功時の結果もそこに来るため、サーバは標準エラー出力を異常として扱わず、標準出力と連結して返す。

### エラー時の文言

標準エラー出力をそのまま返したうえで、原因に応じた一文を添える。
`ego-browser` が見つからない場合（ENOENT）は `EGO_BROWSER_BIN` の設定を促し、
時間切れの場合は作業の分割を促し、それ以外は ego lite が起動していない可能性を挙げる。

接続できない場合に ego-browser 自身が返す文言は、ego lite が起動した状態で `--ego-server-name` に
存在しない名前を渡して確認した。`Failed to connect to ego_cli bootstrap` に続けて、
ego lite.app を手動で起動するよう促す内容が返る。

なお、添える一文は ENOENT でも時間切れでもない全てのエラーに付く。
出力が 32MB を超えた場合（`maxBuffer` 超過）にも「ego lite が起動していない可能性がある」と表示され、
原因を取り違えさせる。発生確率が低いため分岐は足していない。

## 未検証事項

- ego lite を実際に終了させた状態でのエラー文言。
- Claude Desktop の承認画面に、スクリプト全文が実際にどう表示されるか。「危険操作の扱い」の方針は、これが読める前提に立っている。

## 対応 OS

ego lite の配布は現時点で macOS のみ。Windows は待機リスト受付（https://lite.ego.app/download）。
このサーバも macOS でのみ確認している。

## 参考

- ego-browser 技術ドキュメント: https://lite.ego.app/document/en/docs/ego-browser
- ego (lite) クイックスタート: https://lite.ego.app/document/en/docs/quick-start
- GitHub (citrolabs/ego-lite): https://github.com/citrolabs/ego-lite
- ego (lite) 公式サイト: https://lite.ego.app/
