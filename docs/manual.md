# 利用マニュアル (Nano API Proxy)

このドキュメントは、Nano API Proxy を実際に使うための操作マニュアルです。アーキテクチャや設計判断の詳細は[開発仕様書](<Chrome Built-in AI (Gemini Nano) 通信インターセプト ＆ ローカルAPIプロキシ拡張機能 開発仕様書(Nano-API-Proxy).md>)を参照してください。

## 1. 前提条件

- Chrome 138 以降
- Gemini Nano のハードウェア要件（いずれか満たすこと）
  - OS：Windows 10 以降 / macOS 13 以降 / Linux / ChromeOS（Chromebook Plus）
  - ストレージ：空き容量 22GB 以上
  - 性能：VRAM 4GB 超の GPU、または RAM 16GB・4 コア以上の CPU
- モードB（ローカルHTTPサーバー）を使う場合：Go 1.22 以降（同梱の実行バイナリを使う場合は不要）

## 2. インストール

### 2.1 拡張機能を読み込む

1. Chrome で `chrome://extensions` を開く。
2. 右上の「デベロッパーモード」を有効にする。
3. 「パッケージ化されていない拡張機能を読み込む」から、このリポジトリのルートディレクトリ（`manifest.json` があるフォルダ）を選択する。
4. 読み込まれた「Nano API Proxy」の拡張機能ID（32文字の英字列）を控えておく（モードBのセットアップで使用）。

### 2.2 サイドパネルを開く

拡張機能アイコンをクリックするとサイドパネルが開きます。開いた直後、`Built-in AI:` の右側にステータスバッジが表示されます。

| バッジ | 意味 | 対応 |
|---|---|---|
| `AVAILABLE` | すぐに使える | そのまま利用可能 |
| `DOWNLOADABLE` | モデル未ダウンロード | 表示される「モデルをダウンロード」ボタンを押す |
| `DOWNLOADING` | ダウンロード中 | 進捗バーが表示されるので待つ |
| `UNAVAILABLE` | この端末では利用不可 | 2.1節のハードウェア要件を確認する |
| `UNSUPPORTED` | Prompt API 自体が存在しない | Chromeのバージョンを確認する（138以降が必要） |

## 3. モードA：ブラウザ内での `fetch` 横取り

Web アプリ側のコードを一切変更せずに使えるモードです。

1. サイドパネルの `Intercept` トグルを ON にする。
2. 既定では `http://localhost/*` と `http://127.0.0.1/*` が対象です。対象を変えたい場合は Settings タブの「Intercept 対象オリジン」に1行1パターンで入力し「保存」を押す。
3. 対象ページ内で、OpenAI / Anthropic / Gemini のいずれかの形式で `fetch` を実行すると、実際のネットワークに出ることなく Gemini Nano の応答が返ってくる。

対応しているエンドポイント形式：

| ベンダー | パス | 備考 |
|---|---|---|
| OpenAI | `/v1/chat/completions` | `stream: true/false` 両対応 |
| OpenAI | `/v1/models` | 固定のモデル一覧を返す |
| Anthropic | `/v1/messages` | Messages API 互換 |
| Google Gemini | `/models/{model}:generateContent` / `:streamGenerateContent` | URL のアクションでストリーミングの有無が決まる |

判定はリクエスト先のパス名だけで行われるため、宛先ホストは実在の `api.openai.com` などでも、テスト用の適当なホスト名でも構いません（実際にネットワークへは出ません）。

**動作確認の方法**：`demo/` フォルダに、このモードAを試すためだけの簡易デモアプリを同梱しています。使い方は [demo/README.md](../demo/README.md) を参照してください。おおまかな流れ：

```bash
cd demo
python3 -m http.server 5500
```

ブラウザで `http://127.0.0.1:5500/` を開き、Vendor（OpenAI / Anthropic / Gemini）を選んでメッセージを送信します。Intercept が ON なら Gemini Nano の応答が返り、OFF なら（ダミーAPIキーによる）通常のネットワークエラーになります。これは「横取りされているかどうか」を確認する分かりやすい切り分け方法です。

## 4. モードB：ローカル HTTP サーバー（Chrome の外部から使う）

curl・Python・VS Code拡張機能など、Chrome の外のツールから使いたい場合のモードです。初回だけ Native Messaging Host のセットアップが必要です。

### 4.1 セットアップ（初回のみ）

1. Native Messaging Host のバイナリを用意する。
   - リリースの zip に同梱されている場合：`host/bin/` 以下にお使いのOS・アーキテクチャ向けバイナリがあります。
   - ソースからビルドする場合：
     ```bash
     cd host
     go build -o bin/nano-proxy-host .
     ```
2. 2.1節で控えた拡張機能IDを使って、登録スクリプトを実行する。

   ```bash
   # macOS / Linux
   ./install.sh <拡張機能ID>
   ```

   ```powershell
   # Windows
   .\install.ps1 -ExtensionId <拡張機能ID>
   ```

3. **Chrome を完全に再起動する**（拡張機能の再読み込みだけでは Native Messaging Host マニフェストの変更が反映されないことがあります）。

### 4.2 使い方

1. サイドパネルの `Local Server` でポート番号を確認・変更し（既定 `8080`）、「Start」を押す。
2. ステータスが `RUNNING` になれば起動完了。
3. 外部ツールから叩く。

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer dummy" \
  -d '{"model":"gemini-nano","messages":[{"role":"user","content":"Hello"}]}'
```

ストリーミングで受けたい場合は `"stream": true` を指定し、`curl -N` を使うと届いた順に表示されます。

OpenAI SDK を使う場合は `base_url` を `http://127.0.0.1:8080/v1` に、API キーには任意の文字列を指定してください。

4. 使い終わったら「Stop」を押す。Chrome を終了した場合も自動的にサーバープロセスは終了します。

### 4.3 トラブルシューティング

| 症状 | 原因 / 対応 |
|---|---|
| `Specified native messaging host not found` | `install.sh`/`install.ps1` が未実行、または拡張機能IDが一致していない。4.1節を再実施し、Chromeを再起動する。 |
| `Port XXXX is already in use` | 他のプロセスがそのポートを使用中。サイドパネルの Port 欄で別の番号に変更して再度 Start する。 |
| Start を押しても `ERROR` のまま | `host/bin/` にビルド済みバイナリが無い、または実行権限が無い可能性。`chmod +x host/bin/nano-proxy-host` を確認する。 |

## 5. サイドパネルの見方

### 5.1 Activity Logs タブ

モードA・モードB両方のリクエストを、発生順に一覧表示します。

- `[IN-BROWSER]`（青）：モードAのリクエスト
- `[EXTERNAL-HTTP]`（緑）：モードBのリクエスト
- 各行をクリックすると、送信元・プロンプトの内容・応答本文が展開表示されます
- `TTFT` は最初のトークンが返るまでの時間です
- `Clear Logs` で履歴を消去できます（`chrome.storage.session` に保存されているため、Chromeを終了すると自動的に消えます）

### 5.2 Settings タブ

- **System Prompt Override**：設定すると、クライアントが送ったsystemメッセージを無視してこの内容に差し替えます。テスト用に固定の指示を与えたい場合に使用します。
- **Latency & Jitter Simulation**：最初のトークンまでの遅延（TTFT）と、トークン間の間隔を人為的に追加し、低速回線や高負荷時を再現します。0を指定すると無効になります。
- **Intercept 対象オリジン**：モードAで `fetch` を横取りする対象ページのオリジンパターンです。

## 6. 既知の制約

- 出力の品質・トークン数は本番の各社LLM APIと一致しません（UI挙動や通信フローの確認が主目的です）。
- tools（function calling）、`n > 1`、画像入力には対応していません。該当するリクエストは400エラーになります。
- 横取りできるのは `fetch` のみです。`XMLHttpRequest` や、ページ内のWorkerから発行されたリクエストは対象外です。
- 初回の推論リクエストは、Gemini Nanoモデルの初期化（ウォームアップ）のため数十秒かかることがあります。2回目以降は大幅に速くなります。実際の生成速度は端末のGPU/CPU性能に依存します（`chrome://on-device-internals` でモデルの実行バックエンドを確認できます）。

## 7. アンインストール

1. `chrome://extensions` から拡張機能を削除する。
2. （モードBを使っていた場合）Native Messaging Host のマニフェストを削除する。
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.local.nano.proxy.json`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/com.local.nano.proxy.json`
   - Windows: レジストリキー `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.local.nano.proxy` と、対応するマニフェストファイル
