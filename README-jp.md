# One Image to 3D Scene

[English](README.md)

**単眼RGB画像1枚**から3Dシーンを復元するシステムです。

複数視点の画像や深度センサーから点群を復元する従来の方法とは異なり、本システムは**オブジェクトベース**のアプローチをとります。画像内の物体を一つずつ認識し、隠れている部分や画像の外にはみ出した部分を生成AIで補完し、物体ごとに3Dモデルを生成してから、単眼深度推定を使って3D空間に配置します。

[引用](#引用) に記載した論文の実装です。

<table>
  <tr>
    <td><img src="samples/cafe-couple.webp" alt="入力：カフェの丸いテーブルで笑い合う2人" width="420"></td>
    <td><img src="docs/images/scene-hero.webp" alt="写真のカメラの位置から見た、復元した3Dシーン" width="420"></td>
  </tr>
  <tr>
    <td align="center">入力：1枚の写真</td>
    <td align="center">復元した3Dシーン（自動、写真のカメラの位置から見たもの）</td>
  </tr>
</table>

サンプル画像はすべて生成AIで作成したもので、アプリを試す際にお使いください。上の [`samples/cafe-couple.webp`](samples/cafe-couple.webp) は Gemini で作成しました。[`samples/table-talk.webp`](samples/table-talk.webp) は論文で入力として使ったもので、下の「処理の流れ（サンプル画像）」でも使っています。ほかの場面での試験には、次の2枚を使いました。[`samples/office-desk.webp`](samples/office-desk.webp) は人物のいない机の写真で、右端で切れた椅子、机に隠れたオフィスチェア、画面の背面側から見たノートPCを含みます。[`samples/woman-at-desk.webp`](samples/woman-at-desk.webp) はL字型の机に横向きで座る人物の写真で、本棚とフロアランプが画像の端で切れています（VLM が机を長方形と記述した場合は、注釈を「L字型」に直してください）。

上の3Dシーンは自動で配置した結果です。配置は、3D Scene タブの編集モード（**Edit ON**）で手で調整することもできます（下の「手で編集した結果」を参照）。

<p align="center"><img src="docs/images/demo-rotate.gif" alt="論文のサンプルの3Dシーンをアプリで回したところ" width="480"></p>
<p align="center"><sub>論文のサンプルの3Dシーンを、アプリで回したところです（自動の配置）。処理の流れ全体のデモ動画：<a href="docs/videos/demo-ja.mp4"><code>docs/videos/demo-ja.mp4</code></a>（24秒、正方形、日本語字幕）、<a href="docs/videos/demo.mp4"><code>docs/videos/demo.mp4</code></a>（33秒、英語字幕）</sub></p>

手法と実装の解説記事を Qiita に書きました：[生成AIで隠れた部分を描き足しても位置がずれない：1枚の写真から3Dシーンを組み立てる](https://qiita.com/miwastsuki2026/items/08ce2be1fc32118401ae)

## 特徴

- **一部しか写っていない物体も、正しい大きさで置ける。** 生成AIが隠れた部分を描き足す間も、見えている部分を決まった位置に保つので、補完画像の中でのその位置が特徴点マッチングなしで分かり、それを基準に3Dモデルを置けます。論文のサンプルの両端の、背もたれの細い部分しか見えない椅子も、人物の後ろに立ちます。
- **描画して比べて、向きを合わせる。** 各3Dモデルを縦軸まわりに回しながら描画して補完画像と比べ（シルエット、縦横比、明暗）、写真と同じようにカメラの方へ向けます。
- **ブラウザで動く。** React と Three.js で作られ、物体マスク（SAM 2.1）と向き合わせはブラウザ内で計算します。物体検出と補完には各自の OpenAI または Gemini の APIキーを、3D生成には Hugging Face の Space を使います。

## 処理の流れ

| # | フェーズ | 手法 |
|---|---|---|
| 1 | 物体検出 | VLM（OpenAI または Gemini）でバウンディングボックス、ラベル、詳細な説明（姿勢・動作・服装）を取得 |
| 2 | 切り出し | HTML5 Canvas API |
| 3 | 画像補完 | 生成AI（OpenAI または Gemini の画像生成）によるアウトペインティングで、姿勢を保ったまま隠れた部分や切れた部分を復元。OpenAI は透明背景で返し、Gemini の場合は背景を除去（BRIA RMBG 2.0 または 3.0） |
| 4 | 見えていた部分の特定 | 補完の間、切り出し画像を既知の枠に保つ（出力と同じ大きさのキャンバス、OpenAI の編集マスク）。その枠の近くを相関で探して確認・補正する。生成AIが動かした場合だけ、AKAZE（OpenCV.js）、Lowe's Ratio Test、RANSAC による拡大率と移動量の推定に戻る |
| 5 | 深度推定 | Depth Anything V2。物体の深度はマスク内の深度の中央値 |
| 6 | 3D生成 | TRELLIS.2 または Hunyuan3D-2.1（Hugging Face Spaces）でテクスチャ付きGLBを生成 |
| 7 | シーン合成 | Three.js。深度マップから作った点群のバウンディングボックス（PC Box）にモデルを合わせて配置。既定では遠近を考慮して3次元に戻す（使い方を参照） |
| 8 | 向き合わせ | 各モデルを縦軸まわりに回して描画し、補完画像と比べる（シルエット、縦横比、明暗）。一致する向きに回し、さらに視線方向の角度だけ回して、写真と同じようにカメラに向ける |

### 処理の流れ（サンプル画像）

最新版での結果です。物体検出と画像補完には OpenAI（補完の画像の右の椅子だけは Gemini）、3D生成には TRELLIS.2 を使い、人物の顔は **Calm** で補完しました。3Dシーンでは、遠近を考慮した配置（遠/近の比 1.5）と向き合わせを使い、各モデルを、補完の間に保った見えていた部分の枠に合わせて置いています（論文の箱による配置）。

<table>
  <tr>
    <td width="50%"><img src="docs/images/step1-detection.webp" alt="物体検出"><br><sub><b>物体検出</b>：VLM が8つの物体を見つけ、ラベルと枠を付けます。</sub></td>
    <td width="50%"><img src="docs/images/step1-masks.webp" alt="物体のマスク"><br><sub><b>切り分け</b>：SAM 2.1（ブラウザ内で実行）が、枠を手がかりに各物体の見えている画素を切り分けます。両端の椅子は、背もたれの細い部分だけが見えています。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/step2-extracted.webp" alt="切り出し"><br><sub><b>切り出し</b>：物体ごとに写真から切り出します。</sub></td>
    <td width="50%"><img src="docs/images/step3-completed.webp" alt="画像補完"><br><sub><b>画像補完</b>：隠れた部分を透明背景で描き足します。見えていた部分は元の位置に保たれる（緑の枠、「Part: kept」）ので、特徴点マッチングは要りません。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/step4-3d-models.webp" alt="3Dモデル"><br><sub><b>3D生成</b>：物体ごとにテクスチャ付きの3Dモデルを作ります（TRELLIS.2）。</sub></td>
    <td width="50%"><img src="docs/images/step5-depth-map.webp" alt="深度マップ"><br><sub><b>深度推定</b>：Depth Anything V2 による深度マップです（明るいほど手前）。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/scene-result.webp" alt="3Dシーン"><br><sub><b>シーン合成</b>：8つの物体を、遠近を考慮してそれぞれの PC Box の奥行きに置きます。背もたれしか見えない椅子も人物の後ろに置かれますが、天板の手前しか見えないテーブルの位置はまだおおよそです。</sub></td>
    <td width="50%"><img src="docs/images/step7-scene-ui.webp" alt="操作パネル付きの3Dシーン"><br><sub><b>3D Scene タブ</b>：シーンと操作パネルです。深度の範囲、点の大きさ、<b>Perspective</b>、<b>Align</b>（向き合わせ）、各種の枠と点群の表示、配置の <b>Save</b> / <b>Load</b>、モデルを手で動かす <b>Edit</b> があります。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/scene-edited.webp" alt="手で編集した3Dシーン"><br><sub><b>手で編集した結果</b>：サンプルのテーブルと椅子の位置と大きさを、編集モード（<b>Edit ON</b>）の移動（Move）と拡大縮小（Scale）で直し、上から見たところです。カップと花瓶がテーブルに載り、2人が椅子に座っています。</sub></td>
    <td width="50%"></td>
  </tr>
</table>

## 必要な環境

- Node.js 18以上
- **OpenAI または Google Gemini の APIキー**（物体検出と画像補完で別々のプロバイダーを使う場合は両方）
- **Hugging Face トークン**（TRELLIS.2 / Hunyuan3D-2.1 による3D生成では必須。背景除去と深度推定でも推奨。ZeroGPUの利用分が各自の枠で計上されます）。Hugging Face の **Settings → Access Tokens** で **Read** のトークンを作り、アプリの画面右上の **HF Token** 欄に入力します。詳しくは [docs/hugging-face-spaces-jp.md](docs/hugging-face-spaces-jp.md) を参照してください

## セットアップ

```bash
git clone https://github.com/IWATSUKI-Masami/one-image-to-3d-scene.git
```

```bash
cd one-image-to-3d-scene
```

```bash
npm install
```

APIキーは画面上で入力するか、`.env.local` に書きます（`.env.example` をコピーしてください）。

```bash
cp .env.example .env.local
```

```bash
npm run dev
```

ブラウザで `http://localhost:3000` を開きます。

> [!WARNING]
> `VITE_` で始まる環境変数は、ビルド時に**JavaScriptにそのまま埋め込まれます**。また、APIはブラウザから直接呼び出されます。手元で動かす分には問題ありませんが、**キーを含んだビルドを公開サーバーにデプロイしないでください**。誰でもキーを読めてしまいます。公開する場合は `.env.local` を空にし、利用者それぞれが画面でキーを入力する形にしてください。

## AIプロバイダーとモデル

**AI Settings** はアプリの設定画面です。画面右上、HF Token の入力欄の左隣にある丸いボタンから開きます。ボタンの表示は、API キーが未設定のときは **Set API Keys**（灰色）、設定済みのときは **AI: Gemini / Gemini** のように使っているプロバイダー名（緑色）になります。API キーが必要な処理をキーなしで始めた場合も、自動で開きます。

AI Settings では次の項目を設定できます。

| 項目 | 内容 |
|---|---|
| Object detection & checks | 物体検出・チェックに使う AI（OpenAI / Gemini。既定は OpenAI） |
| Image completion | 画像補完に使う AI（OpenAI / Gemini。既定は OpenAI） |
| Background removal | 背景除去のモデル（RMBG 2.0 / RMBG 3.0。既定は RMBG 2.0）。Gemini で補完するときだけ使い、OpenAI を選んでいる間は選択できない |
| API keys | OpenAI と Gemini の API キー |
| Models | 使うモデルの ID |
| Hugging Face Spaces | 背景除去・深度推定・3D 生成で使う Space の ID（複製した Space など） |

既定のモデルは次のとおりです。

| 処理 | プロバイダー | 既定のモデル |
|---|---|---|
| 物体検出、キャンバス拡張量の推定、補完結果のチェック | OpenAI / Gemini | `gpt-5.6-sol` / `gemini-pro-latest` |
| 画像補完（アウトペインティング） | OpenAI / Gemini | `gpt-image-2.6-sunburst` / `gemini-3-pro-image` |

- OpenAI は補完画像を透明背景で返します。Gemini は透明背景を出力できないため、補完後に背景除去を行います。背景除去に失敗した場合は、補完画像のカードに表示されます。
- 物体検出と画像補完の既定は、どちらも OpenAI です。
- 背景除去には **BRIA RMBG 2.0**（既定）または **BRIA RMBG 3.0** を使います。AI Settings の **Background removal** で選べます。OpenAI で補完している間は背景除去を使わないので、選択できなくなります。どちらの Space も API は同じです。RMBG 2.0 はずっと軽く、複製すれば T4 で動きます。
- モデルIDは頻繁に変わります。モデルが提供終了になった場合は、AI Settings で新しいIDを入力してください。コードの変更は不要です。
- 論文の結果は `gemini-3-pro-preview` と `gemini-3-pro-image-preview`（どちらも提供終了）で得たものです。他のプロバイダーやモデルでも同じプロンプトを使いますが、検出精度や姿勢の保持には差が出る可能性があります。
- APIキーはメモリ上にだけ保持します。プロバイダーとモデルIDはブラウザに記憶されます。

### Hugging Face Spaces

背景除去、深度推定、3D生成では、次の Space を呼び出します。AI Settings の **Hugging Face Spaces** で変更できます。

| 処理 | 既定の Space |
|---|---|
| 背景除去（RMBG 3.0 / 2.0） | `briaai/BRIA-RMBG-3.0`、`briaai/BRIA-RMBG-2.0` |
| 深度推定 | `depth-anything/Depth-Anything-V2` |
| 3D生成 | `microsoft/TRELLIS.2`、`tencent/Hunyuan3D-2.1` |

公式の Space は ZeroGPU で動いており、利用者ごとに1日の利用枠があります（Hugging Face PRO では枠が大きくなります）。多数の物体を処理する場合は、Space を自分のアカウントに複製し（Space のページの **Duplicate this Space**）、専用 GPU を割り当てて、その ID を入力してください。専用 GPU は時間課金なので、使い終わったら Space を一時停止してください。

**手順の詳細**（トークン、モデルの利用規約への同意、シークレット `HF_TOKEN`、Hunyuan3D-2.1 の複製に必要な修正、よくあるエラー）は [docs/hugging-face-spaces-jp.md](docs/hugging-face-spaces-jp.md) にまとめています。

- **TRELLIS.2**：**A100**（80GB）を使ってください。TRELLIS.2 の開発元は 24GB 以上を必要とし、動作確認は A100/H100 だけです。また、Space は特定の GPU 向けにビルド済みの CUDA 拡張機能を読み込むため（今の公式 Space は ZeroGPU の GPU 向け）、それより小さい GPU や種類の違う GPU では動かないことがあります。
- **Hunyuan3D-2.1**：**A100**（80GB）を使ってください。形状とテクスチャの生成に約 29GB が必要で、Space は CUDA 拡張機能を A100/A10G 系の GPU 向けにビルドします。公式の Space は ZeroGPU 用なので、複製した場合はいくつかのファイルの修正（Python 3.10、Gradio 5.33.0、torch の固定、bpy の除去、`custom_rasterizer` のソースからのコンパイル、`zero.startup()` の無効化）が必要です。上の手順の詳細を参照してください。
- **深度推定**：T4 で十分です。
- **背景除去**：BRIA RMBG 3.0 は約 25GB（bf16 の重み）の4ステップの拡散モデルなので、**L40S** など 48GB の GPU が必要です。T4 や 24GB の GPU ではメモリが不足します。T4 を使う場合は、RMBG 2.0 を選び、`briaai/BRIA-RMBG-2.0` を複製してください。なお、RMBG 3.0 のモデルはゲート付きです。`briaai/RMBG-3.0` と `briaai/Fibo-2.0-edit-turbo` の利用規約に同意し、HF トークンを Space のシークレット `HF_TOKEN` として登録してください。
- **OpenAI で補完する場合**は背景がすでに透明なので、背景除去の Space はまったく不要です。
- BRIA RMBG のモデルは非商用利用（CC BY-NC 4.0）として公開されています。それ以外の用途では、モデルカードを確認してください。非公開の Space には、読み取り権限のある HF トークンが必要です。

## 使い方

1. **Detect & Crop**：画像をアップロードしてシーンを解析します。検出された物体は自動で切り出されます。
   - **注釈**：補完の前に、各物体のラベルと説明文をカードで編集できます（鉛筆のアイコン）。説明文は補完の指示に使われるので、隠れた部分の誤った推測を直せます（例：「長方形の机」を「L字型の机。右側が奥へ伸びている」に直す）。**EN / 日本語** で、カードの表示を英語と日本語で切り替えられます。日本語は VLM で翻訳し、日本語で編集した内容は英語に翻訳して指示に使います。
   - **物体マスク**（物体検出の直後に自動で実行。進み具合は写真の上の **Segment Objects** ボタンに表示）：検出した各物体の見えている画素を、その枠をプロンプトにして [SAM 2.1](https://huggingface.co/onnx-community/sam2.1-hiera-small-ONNX) で切り分けます。ブラウザ内で動き（transformers.js。WebGPU があれば使い、なければ WebAssembly）、API キーやトークンは不要です。モデル（約 70〜90 MB）は初回に Hugging Face からダウンロードされ、ブラウザにキャッシュされます。マスクは写真に重ねて表示され（**Masks** チェックボックス）、プロジェクトに保存されます。各物体の奥行き（式(4)）には、補完画像の透明度の代わりにこのマスクを使います。補完で物体の画素だけを描いて固定するのにも使います（手順2）。切り分けの途中で補完を始めた場合は、マスクができるのを待ってから補完します。**Segment Again** で切り分け直せます（失敗した場合や、マスクのないプロジェクトを読み込んだ場合など）。
2. **Image Completion**：切り出した物体を補完します（人物は全身、物体は欠けた部分）。補完後に背景が除去されます。まず VLM が、写真全体を見て、各物体が枠の外へ各方向にどこまで続いているかを推定します。切り出し画像は、画像生成AIの出力と同じ大きさのキャンバスに、隠れた部分の余白を取って置かれます。物体マスクを使って物体の画素だけを描き、OpenAI では編集マスクでその部分を変更不可にします。見えていた部分が位置を保てば（枠の近くを相関で探して確認。生成AIによる小さなずれや大きさの変化も補正）、補完画像の中でのその枠が、特徴点マッチングなしで分かります（カードの表示「Part: kept」）。保てなかった場合は AKAZE マッチングを使います（「Part: matched」）。補完の結果は、切れている部分や不自然な比率（脚が短いなど）がないかを確認し、あれば最大2回までキャンバスを広げてやり直します。見えていた部分の位置が保たれなかった場合は同じキャンバスでやり直し、最大3回のうち最もよい結果を使います。また、物体を赤い枠で示した写真全体を、見た目と向きの参考として生成AIに渡します。**Face** で人物の顔の描き方を選べます。**Calm**（既定。顔をくっきり描き、口を閉じた穏やかな表情にする。開いた口や歯は3Dで不気味に見えやすいため）、**Redraw**（顔をくっきり描き、表情はそのまま）、**Mannequin**（目鼻を描かないマネキン風）、**As in photo**（写真のまま）です。Completed のカードには、補完に使ったサービスと顔の描き方（例：「OpenAI · Face: Calm」）が表示されます。人物の3Dモデルは、オプションによらず高い解像度で生成します。
3. **3D Generation**：補完した画像から3Dモデルを生成します。3D生成モデルは、補完画像の視点を保つとは限りません（斜めから見た椅子が別の向きで作られるなど）。そこで、生成したモデルを縦軸まわりの各角度で描画して補完画像と比べ（シルエットの重なり、縦横比、明暗）、最もよく一致する角度だけモデルを回して、正面の姿を補完画像に合わせます（向き合わせ）。モデルのカードの表示、見えていた部分の枠、3Dシーンのすべてでこの向きを使います。シーンの **Align** チェックボックスでオフにできます。
4. **3D Scene**：深度マップを生成し、組み立てられたシーンを表示します。位置はTransformControlsで調整でき、glTF/GLBで書き出せます。
   - **Perspective**（チェックボックス。既定でオン）：点群、PC Box、モデルを、原点に置いたピンホールカメラ（水平画角 60° と仮定）から3次元に戻します。深度マップは、Depth Anything V2 の出力どおり視差（距離の逆数）として読みます。Depth Anything V2 は画像ごとに出力を全範囲に引き伸ばすので、一番遠い点と一番近い点の距離の比は分かりません。Perspective がオンのときは、**Depth** スライダーでこの比（遠/近）を設定します（既定 1.5。サンプル写真で、カップと人物の頭の大きさの比が現実的になる値です。奥行きの大きい場面では大きくしてください）。物体は現実の大きさの比を保つので、カメラの近くのカップが奥の人物と同じくらいの大きさになることはありません。また、最初のカメラの位置（写真のカメラの位置）から見ると、写真と同じ見え方になります。**チェックを外すと、論文の配置を再現します**。論文の配置では、物体を画像上の大きさのまま置き、明るさを直線的に距離に対応させるので、カメラに近い物体ほど大きくなりすぎます。
処理の詳細はプロジェクトに保存され、ブラウザのコンソールを見なくても確認できます。補完のカードには試行回数が表示され（カーソルを重ねると各試行の確認結果と位置の一致度）、3Dモデルのカードには向き合わせの角度と一致度が表示されます。ヘッダーの **Stats** で、これらを補完した物体ごとに1行の CSV ファイルとして保存できます（画像の端に接している辺、マスクの被覆率、推定した隠れた部分の広がり、編集マスクの有無、見えていた部分の特定方法、試行回数、位置の一致度、向き合わせの角度・一致度・IoU、処理時間）。手持ちの写真で手法を評価するときに使えます。

プロジェクト（画像、深度マップ、モデル）は保存と読み込みができます。手で調整したシーンの配置は、シーンのパネルの **Save** で別に保存します（下記）。

### 費用：AI の使用量を抑えるには

自動での配置は正確さを優先しているため、API の呼び出し（OpenAI / Gemini のクレジット）と GPU の時間を使います。

| 手順 | 呼び出し |
|---|---|
| 物体検出 | 写真1枚につき VLM を1回 |
| 画像補完（物体ごと） | VLM を1回（物体が枠の外へどこまで続くか）。その後、1回の試行ごとに画像生成を1回（写真全体を2枚目の参考画像として渡す）と VLM による確認を1回。切れている部分がある、比率が不自然、見えていた部分が動いた場合は、最大3回まで試行を繰り返す。1つの物体で、画像生成が最大3回、VLM が最大4回になる。**Attempts: 1** にすると、画像生成1回と VLM 1回 |
| 3D生成（物体ごと） | Hugging Face の Space を1回（GPU の時間・ZeroGPU の利用枠。API のクレジットではない）。人物は高い解像度で生成する |
| 物体マスク（SAM 2.1）、向き合わせ、深度による配置 | ブラウザ内で実行（深度マップは写真1枚につき Space を1回）。API のクレジットは使わない |

試行の繰り返しは、物体を自動で正しく配置するためのものです。**自動での配置の正確さにこだわらず、シーンを自分で調整するなら、必要な機能だけを使ってください。**

- **Complete** の隣の **Attempts** を **1 (fewest credits)** にする：各物体の補完を1回だけ行い、確認とやり直しをしない。
- 補完と3D生成は、必要な物体だけに行う（カードを選択する）。たとえば、一部しか写っていない椅子やテーブルは除く。
- 最初の結果を使う：カードに「Part: matched」や「Part: not found」と出ても補完し直さず、配置を手で直す。
- シーンを手で調整する：3Dシーンで **Edit ON** にしてモデルをクリックし、移動・回転・拡大縮小の操作で直す（**Reset** で自動の配置に戻せる）。シーンのパネルの **Save** で、配置（各モデルの位置・回転・大きさ、シーンの設定、カメラ）を小さな JSON ファイル（数KB）に保存できる。モデル自体は含まないので、同じプロジェクトで **Load** から読み込む。手で直した配置は、深度の範囲を変えるなどでシーンを作り直しても保たれる。**GLB** は、配置したモデルを1つの GLB ファイルに書き出す（ほかの3Dソフト向け。すべてのモデルを含むので大きい）。
- 物体マスク、向き合わせ、3Dシーン自体はクレジットを使わないので、オンのままでよい。


## ディレクトリ構成

```
├── App.tsx                 # メインアプリ（UIと処理の流れ）
├── components/             # Reactコンポーネント（3Dビューア、カード、オーバーレイ）
├── services/
│   ├── aiService.ts        # 物体検出・補完・チェックのプロンプト
│   ├── segmentation.ts     # 写真上の物体マスク（ブラウザ内の SAM 2.1）
│   ├── frontAlignment.ts   # モデルの向きを補完画像に合わせる（描画して比べる）
│   └── ai/                 # プロバイダー層（OpenAI / Gemini）と既定のモデル
├── utils.ts                # 切り出し、AKAZEマッチング、深度推定、3D生成API
├── types.ts                # 型定義
├── samples/                # サンプル画像
└── docs/                   # Hugging Face Spaces の手順、開発の経緯、今後の拡張、README の画像とデモ動画
```

## 今後の拡張

3D生成への [Pixal3D](https://huggingface.co/TencentARC/Pixal3D)（ピクセル整合型の画像-to-3D）の追加と、[ComfyUI](https://www.comfy.org/) による手元の GPU での3D生成、模様の少ないごく一部しか写っていない物体（天板の手前の端しか見えないテーブルなど）の配置の改善、向き合わせでの対称に近い物体の前後の取り違えへの対処、カメラの画角と遠/近の距離の比の較正（遠近を考慮した配置は、今は画角 60° を仮定）、人物の顔の改善を予定しています。詳しくは [docs/roadmap-jp.md](docs/roadmap-jp.md) を参照してください。

## 引用

研究で利用される場合は、以下の論文を引用してください。同じ内容を [`CITATION.cff`](CITATION.cff) にも書いてあるので、GitHub のリポジトリのページの About 欄にある **Cite this repository** から、APA や BibTeX の形式でコピーできます。

岩月 正見, 渡邊 瑞輝, 「単眼画像からの深度ベース高精度3Dシーン復元 ―生成AIによるオブジェクトベースアプローチ―」, 信学技報, KBSE2025-61, pp.73–78, 2026年3月.

```bibtex
@techreport{iwatsuki2026oneimage3d,
  author      = {Iwatsuki, Masami and Watanabe, Mizuki},
  title       = {Depth-Based High-Precision {3D} Scene Reconstruction from a Single Monocular Image: Object-Based Approach Using Generative {AI}},
  institution = {The Institute of Electronics, Information and Communication Engineers},
  type        = {IEICE Technical Report},
  number      = {KBSE2025-61},
  pages       = {73--78},
  year        = {2026},
  month       = mar
}
```

## ライセンス

[MIT](LICENSE)

このリポジトリに含まれるのはアプリケーションのコードのみです。呼び出している外部のモデルやAPI（Gemini、OpenAI、TRELLIS.2、Hunyuan3D-2.1、Depth Anything V2、BRIA RMBG 3.0 / 2.0、SAM 2.1 など）には、それぞれのライセンスと利用規約が適用されます。特に商用で利用する場合は、事前に確認してください。

特に [Tencent Hunyuan 3D 2.1 Community License](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE) は、EU、英国、韓国では適用されません。これらの地域では TRELLIS.2（MIT）を使ってください。

## 更新履歴

[CHANGELOG.md](CHANGELOG.md) を参照してください。公開前の開発は非公開のリポジトリで行いました。その経緯は [docs/development-history-jp.md](docs/development-history-jp.md) にまとめています。
