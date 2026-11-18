# 今後の拡張

[English](roadmap.md)

まだ実装していない、今後の拡張の予定です。以下の内容は 2026年11月時点で確認したものです。

## 1. 3D生成への Pixal3D の追加（Hugging Face Space）

[Pixal3D](https://huggingface.co/TencentARC/Pixal3D)（Tencent ARC、SIGGRAPH 2026、MIT ライセンス）は、PBR テクスチャ付きのメッシュ（GLB）を出力する画像-to-3D モデルです。

### このシステムに合う理由

多くの3D生成モデルは、形状を独自の座標空間で作るため、画像の画素と3Dモデルの対応があいまいになります。Pixal3D は **ピクセル整合生成** を採用しています。MoGe で推定したカメラの画角を使って画素を3Dに逆投影するため、**生成されたモデルの正面が入力画像と1対1で一致します**。

このシステムでは、補完画像の中の物体領域（tightBox2d）が PC Box に一致するように、モデルの拡大率と位置を決めています（論文の 3.5.3 節）。正面が入力画像と一致するモデルなら、この位置合わせがより正確になると期待できます。

### 実現方法

- 公式 Space [TencentARC/Pixal3D](https://huggingface.co/spaces/TencentARC/Pixal3D) が ZeroGPU で稼働しており、`preprocess`、`generate_3d`、`extract_glb_api` の API を公開しています。TRELLIS.2 と同じ構成なので、同じ方法で追加できます（手元の GPU は不要）。
- 実装時に確認すること：`generate_3d` のパラメータ、シーン内でのモデルの向き、tightBox2d との位置合わせ。

## 2. ComfyUI によるローカルでの3D生成

3D生成の選択肢として、Hugging Face Spaces に加えて **ComfyUI（ローカル）** を追加します。多くの利用者は適した GPU を持っていないため、既定は Spaces のままとします。

### 目的

- **ZeroGPU の利用上限や Hugging Face トークンが不要**：利用者自身の GPU で生成するため、待ち時間も安定します。
- **再現性**：モデルとワークフローのバージョンを固定できるため、論文の再現実験に向いています。
- **プライバシー**：画像が利用者の PC の外に出ません。
- **モデルを足しやすい**：ワークフローのファイルを差し替えるだけで、モデルを切り替えられます。

### 候補のモデル

ComfyUI の公式ドキュメントで確認した内容です。

| モデル | ComfyUI での扱い | 出力 | このアプリとの相性 |
|---|---|---|---|
| Pixal3D | 本体のノードで動く。テンプレート「Pixal3D & TRELLIS.2: Image to Model」 | PBR テクスチャ付きメッシュ（GLB） | 良い（1 を参照） |
| TRELLIS.2 | 本体のノードで動く。上と同じテンプレートで `Boolean (Switch to Trellis2)` により切り替え | PBR テクスチャ付きメッシュ（GLB） | 良い |
| Hunyuan3D 2.0 / 2.1 | 本体のノードは **形状のみ（テクスチャなし）** | メッシュ（GLB） | テクスチャ付き GLB を返す Hunyuan3D-2.1 の Space の方が良い |
| TripoSplat | 本体のノードで動く | **ガウシアンスプラット**。オプションの `SplatToMesh` で GLB に変換可能 | 優先度は低い（下記） |

このアプリは、モデルを GLB のメッシュとして読み込みます。そして、メッシュのバウンディングボックスから PC Box に合わせた拡大率と奥行きのずれを計算し（論文の式(10)(11)）、シーンを glTF/GLB で書き出します。TripoSplat の主な出力であるガウシアンスプラットは、この仕組みに合いません。オプションのメッシュ変換で GLB にはできますが、変換したメッシュが、最初からメッシュを生成するモデル（Pixal3D、TRELLIS.2）を上回る可能性は低いと考えます。

### 設計の概要

- 設定：ComfyUI のアドレス（既定 `http://127.0.0.1:8188`）と、**API 形式**のワークフローファイル（ComfyUI から書き出したもの）。
- Pixal3D / TRELLIS.2 のワークフローをリポジトリに同梱する。
- 呼び出しの流れ（ComfyUI の HTTP API）：
  1. `POST /upload/image`：補完・背景除去済みの画像をアップロード
  2. `POST /prompt`：`LoadImage` ノードにアップロードしたファイル名を入れて、ワークフローを送信
  3. `GET /history/{prompt_id}`：処理が終わるまで状態を確認
  4. `GET /view?filename=…`：保存ノードが出力した GLB をダウンロード
- Pixal3D のワークフローには背景除去（BiRefNet）が含まれており、スイッチで省略できる。このアプリの入力は背景除去済みなので省略する。
- 配置の処理は今のものを使い回す。モデルの向きはワークフローごとに設定する。

### 制約

- **NVIDIA の GPU が必要**：VRAM の目安は、Hunyuan3D 2.0 で約 6〜12GB（形状のみ／形状＋テクスチャ）、TRELLIS.2 で約 24GB（第三者のガイドによる推奨値）。Pixal3D のページには記載がない。
- **モデルのダウンロード**：Pixal3D には、本体の拡散モデルに加えて、TRELLIS.2 の形状・テクスチャ用 VAE、DINOv3、MoGe、BiRefNet が必要。
- **ブラウザからの接続**：アプリがブラウザから呼び出せるように、ComfyUI を `--enable-cors-header` 付きで起動する必要がある。
- **保守**：ComfyUI の更新でノード名が変わると、ワークフローのファイルを直す必要がある。
- **テスト**：GPU のある環境が必要（CPU だけの環境では確認できない）。

## 参考

- [ComfyUI Docs: Pixal3D](https://docs.comfy.org/ja/tutorials/3d/pixal3d)
- [ComfyUI Docs: TRELLIS.2](https://docs.comfy.org/tutorials/3d/trellis2)
- [ComfyUI Docs: Hunyuan3D 2.0 / 2.1](https://docs.comfy.org/ja/tutorials/3d/hunyuan3D-2)
- [ComfyUI Docs: TripoSplat](https://docs.comfy.org/ja/tutorials/3d/triposplat)
- [Hugging Face: TencentARC/Pixal3D（モデル）](https://huggingface.co/TencentARC/Pixal3D)、[（Space）](https://huggingface.co/spaces/TencentARC/Pixal3D)
- [TRELLIS.2 native vs legacy VRAM guide](https://book.st-hakky.com/en/data-science/trellis2-native-vs-legacy-vram-guide)
