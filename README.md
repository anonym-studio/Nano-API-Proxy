# Nano-API-Proxy

Local HTTP &amp; In-Browser Proxy for Chrome Built-in AI

Chrome に内蔵された Gemini Nano（Prompt API）を使って、OpenAI などの LLM API を手元で再現する Chrome 拡張機能です。API キーの取得や課金をせずに、LLM を使うアプリの開発や結合テストを進められます。

> **ステータス：設計段階（未実装）**
> 現在リポジトリにあるのは開発仕様書だけです。以下の機能と使い方は予定の内容で、実装が進むにつれて変わることがあります。

## 特徴

- **ブラウザ内の通信を横取りする（モードA）**：Web アプリの `fetch` を拡張機能が捕捉し、Gemini Nano の応答を返します。アプリのコードを変える必要はありません。外部サーバーも不要で、CORS の制限もかかりません。
- **ローカル API サーバー（モードB）**：サイドパネルからワンクリックで `http://127.0.0.1:8080` に OpenAI 互換サーバーを起動します。curl、Python、VS Code 拡張機能など、Chrome の外のツールからも使えます。Chrome を終了するとサーバーも自動で止まります。
- **OpenAI 互換**：`/v1/chat/completions`（SSE ストリーミングと JSON 一括の両方）と `/v1/models` に対応します。Anthropic Messages API と Gemini API の互換は後続フェーズで追加する予定です。
- **サイドパネルでの監視**：両モードのリクエスト、プロンプト、TTFT（最初のトークンまでの時間）、応答をリアルタイムで一覧表示します。
- **テスト用の設定**：System Prompt の上書きや、遅延・ゆらぎの再現ができます。

## 想定する使い方（予定）

```js
// モードA：Web アプリのコードはそのまま。拡張機能が api.openai.com 宛ての fetch を横取りします
const res = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
  body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "Hello" }] }),
});
```

```bash
# モードB：サイドパネルで Start Server を押したあと
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer dummy" \
  -d '{"model":"gemini-nano","messages":[{"role":"user","content":"Hello"}]}'
```

OpenAI SDK を使う場合は、`base_url` を `http://127.0.0.1:8080/v1` に向け、API キーには任意の文字列を指定します。

## 動作要件

- Chrome 138 以降
- Gemini Nano のハードウェア要件：
  - OS：Windows 10 以降、macOS 13 以降、Linux、ChromeOS（Chromebook Plus）
  - ストレージ：空き容量 22GB 以上
  - 性能：VRAM 4GB 超の GPU、または RAM 16GB・4 コア以上の CPU
- モードBを使う場合：Native Messaging Host の初回登録（`install.sh` / `install.ps1` を同梱予定）

## 制約

- 出力の品質とトークン数は本番のモデルと一致しません。UI の挙動や通信の流れを確かめる用途を想定しています。
- tools（function calling）、`n > 1`、画像入力には対応しません。
- 横取りできるのは `fetch` だけです。`XMLHttpRequest`（ブラウザ版の axios など）や、Worker の中から発行されたリクエストは対象外です。
- 横取りの対象は、既定では `localhost` / `127.0.0.1` のページだけです。

## ロードマップ

1. **Phase 1**：ブラウザ内での `fetch` 横取りと、Gemini Nano によるストリーミング応答
2. **Phase 2**：サイドパネルの UI と通信ログ
3. **Phase 3**：Native Messaging Host（Go）によるローカル HTTP サーバー
4. **Phase 4**：リクエストのキュー制御、Anthropic / Gemini API 互換

## ドキュメント

- [開発仕様書](docs/Chrome%20Built-in%20AI%20(Gemini%20Nano)%20通信インターセプト%20＆%20ローカルAPIプロキシ拡張機能%20開発仕様書(Nano-API-Proxy).md)

## ライセンス

[MIT](LICENSE)
