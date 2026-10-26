# ego-lite MCP サーバ

Claude Desktop の Chat / Cowork から、ブラウザ [ego (lite)](https://lite.ego.app/) を操作するための MCP サーバ。

ego lite 公式の `ego-browser` は skill 形式で、シェルを実行できる CLI エージェント（Claude Code、Codex など）向けに作られている。
シェルを持たない Claude Desktop の Chat / Cowork からは、そのままでは使えない。
このサーバは `ego-browser` CLI を子プロセスとして起動し、JavaScript を渡して実行させることで、その欠けた実行手段を補う。

ツールは 2 本ある。

- `ego_run_script`：Claude がその場で書いた JavaScript を実行する。
- `ego_run_saved_script`：利用者が確かめて配置した保存済みスクリプトを、名前で実行する。中身は Claude には変えられない。

設計の理由と経緯は [docs/design.md](docs/design.md) にある。

## 必要なもの

- macOS（ego lite の配布は現時点で macOS のみ。Windows は[待機リスト受付](https://lite.ego.app/download)）
- ego lite.app（オンボーディングを済ませ、起動していること）
- `ego-browser` CLI（ego lite のオンボーディングで入る）
- Node.js（サーバ自体の実行用。スクリプトは ego-browser 組み込みの Node で動く）

## 導入

リポジトリを取得したディレクトリで依存パッケージを入れる。

```bash
npm install
```

Claude Desktop の設定ファイル `claude_desktop_config.json` の `mcpServers` に、次の項目を加える。
設定ファイルは通常 `~/Library/Application Support/Claude/claude_desktop_config.json` にある。

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
- `EGO_BROWSER_BIN`：`ego-browser` CLI。`command -v ego-browser` で得られる（通常は `~/.local/bin/ego-browser`）

`EGO_BROWSER_BIN` は省略しないほうがよい。
Claude Desktop が起動する子プロセスはログインシェルの環境変数を引き継がないため、PATH から `ego-browser` が見つからないことが多い。

設定を書き換えたら、**Claude Desktop を再起動する**。起動中のプロセスには反映されない。

## 安全上の注意

このサーバは、ego lite に保存された**利用者本人のログイン済みアカウント**で操作する。
送信・購入・削除のような取り消せない書き込みも、サーバ側では止めない。
歯止めは、Claude Desktop のコネクタ設定にある、ツールごとの許可設定である。

| ツール | 許可設定 | 確認する時点 |
|---|---|---|
| `ego_run_script` | **その都度確認** | 実行のたびに、承認画面でスクリプト全文を読む |
| `ego_run_saved_script` | 常に許可にしてよい | 配置のときに、スクリプトを読んでからコピーする |

- **`ego_run_script` を「常に許可」に設定しないこと。** このツールは、ブラウザ操作に加えて、手元のファイルの読み書きと外部への送信もできる。設定した時点で歯止めがなくなる。
- 実行用の場所には、読み取り操作だけを行うスクリプトを置く。`ego_run_saved_script` を常に許可にすると、置いたスクリプトはすべて確認なしで動く。読み取り操作だけであることは、サーバのコードでは確かめていない。
- スケジュールタスクのような無人実行は、`ego_run_saved_script` だけで完結させる。`ego_run_script` を呼ぶと、承認待ちのまま止まる。

## 保存済みスクリプトの配置

保存済みスクリプトは、非公開の git リポジトリなどで書き、中身を読んでから実行用の場所へコピーする。

```bash
mkdir -p ~/.config/ego-lite-mcp/scripts
cp my-script.js ~/.config/ego-lite-mcp/scripts/
```

- **シンボリックリンクにしないこと。** リンクは実行されない。リンクの先が承認なしに書き換わるのを防ぐためである。実行用の場所のフォルダ自体もリンクにしない。
- 名前（`.js` を除いた部分）は、英小文字・数字・ハイフンだけで、64 文字までにする。
- スクリプトは ego lite の中の Node.js で動く。作業ディレクトリは `/` で、環境変数は引き継がれないので、ファイルは絶対パスで指定する。失敗しても `finally` でタスクスペースを閉じる。書き方の規則は [docs/design.md](docs/design.md) の「保存済みスクリプト」の節にある。

Claude Desktop で `ego_run_saved_script` を名前なしで呼ぶと、置かれているスクリプトの名前の一覧が返る。

## 動作確認

リポジトリのディレクトリで、シェルから標準入出力越しの疎通を確認する。

```bash
EGO_BROWSER_BIN="$(command -v ego-browser)" node test.mjs
```

`initialize`、`tools/list`、`ego_run_script` の呼び出し（成功時と例外送出時）、`ego_run_saved_script` の呼び出し（一覧、不正な名前、存在しない名前、リンク、正常な実行）を順に検査し、問題がなければ `all checks passed` と出る。
`ego_run_saved_script` の検査は一時ディレクトリで行い、実行用の場所には触れない。

続いて Claude Desktop 上で、`ego_run_script` を 2 段階で呼ぶ。
順番に意味がある。

第 1 段階では、ブラウザ本体には接続せず、サーバの起動・`ego-browser` の発見・ツールの受け渡しだけを確かめる。

```js
await help("taskSpace")
```

第 2 段階では、実際にページを開いてタスクスペースを閉じる。

```js
const task = await taskSpace("smoke test");
const page = task.page("p1");
await page.goto("https://example.com");
console.log(task.spaceId, await page.snapshot());
await task.finish({ keep: [] });
```

第 1 段階が通り、第 2 段階で `Failed to connect to ego_cli bootstrap` が返った場合は、ego lite が起動しているかを確かめる。
起動していてもこのエラーが出るなら、原因は「Claude Desktop が起動した子プロセスから ego lite の内部サービスに届かない」に絞られる。

サーバが起動しない場合は `~/Library/Logs/Claude/mcp-server-ego-lite.log` を見る。
`Cannot find module` が出ていれば、`args` のパスが間違っている。

## ドキュメント

- [docs/design.md](docs/design.md)：設計の判断と経緯、未検証事項
- [docs/ego-lite-control-layer.md](docs/ego-lite-control-layer.md)：ego-browser スキル、このサーバの実装、比較検証の解説（2026-10-15 時点）

## ライセンス

[MIT](LICENSE)

## 参考

- ego-browser 技術ドキュメント: https://lite.ego.app/document/en/docs/ego-browser
- ego (lite) クイックスタート: https://lite.ego.app/document/en/docs/quick-start
- GitHub (citrolabs/ego-lite): https://github.com/citrolabs/ego-lite
- ego (lite) 公式サイト: https://lite.ego.app/
