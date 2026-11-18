# 今後の拡張

[English](roadmap.md)

まだ実装していない、今後の拡張の予定です。

## ComfyUI によるローカルでの3D生成

3D生成の選択肢として、Hugging Face Spaces（TRELLIS.2、Hunyuan3D-2.1）に加えて **ComfyUI（ローカル）** を追加します。多くの利用者は適した GPU を持っていないため、既定は Spaces のままとします。

### 目的

- **ZeroGPU の利用上限や Hugging Face トークンが不要**：利用者自身の GPU で生成するため、待ち時間も安定します。
- **再現性**：モデルとワークフローのバージョンを固定できるため、論文の再現実験に向いています。
- **プライバシー**：画像が利用者の PC の外に出ません。
- **モデルを足しやすい**：ワークフローのファイルを差し替えるだけで、モデルを切り替えられます。

### 候補のモデル

ComfyUI のドキュメント（2026年11月時点）で確認した内容です。

| モデル | ComfyUI での扱い | 出力 | このアプリとの相性 |
|---|---|---|---|
| TRELLIS.2 | 本体のノードで動く | PBR テクスチャ付きメッシュ | 良い |
| Pixal3D | 本体のノードで動く | メッシュ | 要評価 |
| Hunyuan3D-2 | 本体のノードは**形状のみ**。テクスチャには拡張ノードが必要 | メッシュ | テクスチャ付き GLB を返す Hunyuan3D-2.1 の Space の方が良い |
| TripoSplat | — | **ガウシアンスプラット** | 使えない（下記） |

ガウシアンスプラットのモデルは、このアプリには合いません。このアプリは、モデルを GLB のメッシュとして読み込みます。そして、メッシュのバウンディングボックスから PC Box に合わせた拡大率と奥行きのずれを計算し（論文の式(10)(11)）、glTF/GLB で書き出します。スプラットに対応するには、専用の描画処理、点の分布からのバウンディングボックス計算、GLB 以外の書き出し形式が必要になります。

### 設計の概要

- 設定：ComfyUI のアドレス（既定 `http://127.0.0.1:8188`）と、**API 形式**のワークフローファイル（ComfyUI から書き出したもの）。
- TRELLIS.2 用のワークフローをリポジトリに同梱する。
- 呼び出しの流れ（ComfyUI の HTTP API）：
  1. `POST /upload/image`：補完・背景除去済みの画像をアップロード
  2. `POST /prompt`：画像読み込みノードにアップロードしたファイル名を入れて、ワークフローを送信
  3. `GET /history/{prompt_id}`：処理が終わるまで状態を確認
  4. `GET /view?filename=…`：保存ノードが出力した GLB をダウンロード
- 配置の処理は今のものを使い回す。モデルの向きはワークフローごとに設定する（TRELLIS.2 は回転なし）。

### 制約

- **NVIDIA の GPU が必要**：VRAM の目安は、Hunyuan3D-2 で約 6〜12GB（形状のみ／形状＋テクスチャ）、TRELLIS.2 で約 24GB（推奨値）。
- **ブラウザからの接続**：アプリがブラウザから呼び出せるように、ComfyUI を `--enable-cors-header` 付きで起動する必要がある。
- **保守**：ComfyUI の更新でノード名が変わると、ワークフローのファイルを直す必要がある。
- **テスト**：GPU のある環境が必要（CPU だけの環境では確認できない）。

### 参考

- [ComfyUI Docs: TRELLIS.2](https://docs.comfy.org/tutorials/3d/trellis2)
- [ComfyUI Docs: Hunyuan3D-2](https://docs.comfy.org/ja/tutorials/3d/hunyuan3D-2)
- [ComfyUI Docs: TripoSplat](https://docs.comfy.org/ja/tutorials/3d/triposplat)
- [ComfyUI Blog: TRELLIS.2 and Pixal3D are now native](https://blog.comfy.org/p/trellis2-and-pixal3d-are-now-native)
