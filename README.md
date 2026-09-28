# Nano-API-Proxy

Local HTTP &amp; In-Browser Proxy for Chrome Built-in AI

Chrome に内蔵された Gemini Nano（Prompt API）を使って、OpenAI などの LLM API を手元で再現する Chrome 拡張機能です。API キーの取得や課金をせずに、LLM を使うアプリの開発や結合テストを進められます。

> **ステータス：Phase 1〜4 実装済み（実機での動作検証は未実施）**
> コードは一通り揃っていますが、Chrome にロードしての実機検証はまだ行っていません。詳細な未検証事項は[開発仕様書](docs/Chrome%20Built-in%20AI%20(Gemini%20Nano)%20通信インターセプト%20＆%20ローカルAPIプロキシ拡張機能%20開発仕様書(Nano-API-Proxy).md)の §8 を参照してください。

## 特徴

- **ブラウザ内の通信を横取りする（モードA）**：Web アプリの `fetch` を拡張機能が捕捉し、Gemini Nano の応答を返します。アプリのコードを変える必要はありません。外部サーバーも不要で、CORS の制限もかかりません。
- **ローカル API サーバー（モードB）**：サイドパネルからワンクリックで `http://127.0.0.1:8080` に OpenAI 互換サーバーを起動します。curl、Python、VS Code 拡張機能など、Chrome の外のツールからも使えます。Chrome を終了するとサーバーも自動で止まります。
- **3 種類の API 互換**：OpenAI Chat Completions（`/v1/chat/completions`、SSE ストリーミングと JSON 一括の両方、`/v1/models`）、Anthropic Messages API（`/v1/messages`）、Google Gemini API（`:generateContent` / `:streamGenerateContent`）に対応します。
- **サイドパネルでの監視**：両モードのリクエスト、プロンプト、TTFT（最初のトークンまでの時間）、応答をリアルタイムで一覧表示します。
- **テスト用の設定**：System Prompt の上書きや、遅延・ゆらぎの再現ができます。

## 使い方

### 拡張機能を読み込む

1. Chrome で `chrome://extensions` を開き、「デベロッパーモード」を有効にする。
2. 「パッケージ化されていない拡張機能を読み込む」からこのリポジトリのルートディレクトリを選択する。
3. サイドパネルを開く（拡張機能アイコンをクリック）と、Built-in AI の状態（`AVAILABLE` / `DOWNLOADABLE` など）が表示される。`DOWNLOADABLE` の場合は「モデルをダウンロード」を押す。

### モードA：ブラウザ内での横取り

既定では `http://localhost/*` と `http://127.0.0.1/*` が対象です。対象ページで以下のように `fetch` すると、実際のネットワークに出ることなく Gemini Nano の応答が返ります。

```js
const res = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
  body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "Hello" }] }),
});
```

### モードB：ローカル HTTP サーバー

初回のみ、Native Messaging Host のビルドと登録が必要です。

```bash
(cd host && go build -o bin/nano-proxy-host .)
./install.sh <chrome-extensionのID>   # chrome://extensions に表示されるIDを指定（Windowsは install.ps1）
```

登録後、サイドパネルの「Start」を押すとローカルサーバーが起動します。

```bash
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
- モードBを使う場合：Go 1.22 以降（Native Messaging Host のビルド用）

## 制約

- 出力の品質とトークン数は本番のモデルと一致しません。UI の挙動や通信の流れを確かめる用途を想定しています。
- tools（function calling）、`n > 1`、画像入力には対応しません。
- 横取りできるのは `fetch` だけです。`XMLHttpRequest`（ブラウザ版の axios など）や、Worker の中から発行されたリクエストは対象外です。
- 横取りの対象は、既定では `localhost` / `127.0.0.1` のページだけです。

## 実装フェーズ

1. **Phase 1**：ブラウザ内での `fetch` 横取りと、Gemini Nano によるストリーミング応答
2. **Phase 2**：サイドパネルの UI と通信ログ
3. **Phase 3**：Native Messaging Host（Go）によるローカル HTTP サーバー
4. **Phase 4**：Anthropic / Gemini API 互換アダプター、両モード共通のリクエストキュー

## ドキュメント

- [開発仕様書](docs/Chrome%20Built-in%20AI%20(Gemini%20Nano)%20通信インターセプト%20＆%20ローカルAPIプロキシ拡張機能%20開発仕様書(Nano-API-Proxy).md)

## ライセンス

[MIT](LICENSE)
