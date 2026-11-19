# Hugging Face Spaces の準備と複製

[English](hugging-face-spaces.md)

このアプリは、背景除去・深度推定・3D 生成で Hugging Face の Space を呼び出します。この文書では、そのために利用者が行う準備をまとめます。公式の Space をそのまま使う方法と、自分のアカウントに複製して専用 GPU で動かす方法の両方を説明します。

## 1. Hugging Face トークンを用意する

1. [huggingface.co](https://huggingface.co/) でアカウントを作り、ログインします。
2. **Settings → Access Tokens** で **Create new token** を押し、種類を **Read** にしてトークンを作ります。`hf_` で始まる文字列です。
3. アプリの画面右上にある **HF Token** の欄に入力します。

トークンを入れると、公式 Space の ZeroGPU の利用枠が、自分のアカウントの枠で計上されます。TRELLIS.2 と Hunyuan3D-2.1 による3D生成ではトークンが必須です。非公開の Space を使う場合も、その Space を読める権限のトークンが必要です。トークンはメモリ上にだけ保持し、ブラウザには保存しません。起動時に自動で入れたい場合は、`.env.local` の `VITE_HF_TOKEN` に書いてください。

## 2. 公式 Space をそのまま使う

公式 Space は ZeroGPU で動いており、追加の準備は要りません。ただし、利用者ごとに1日の利用枠があります。Hugging Face PRO では枠が大きくなります。枠を使い切ると、翌日まで待つか、次の手順で Space を複製する必要があります。

## 3. Space を複製して専用 GPU で動かす

### 共通の手順

1. **支払い方法を登録する**：専用 GPU は有料です。**Settings → Billing** で支払い方法を登録します。
2. **Space を複製する**：公式 Space のページ右上の **⋮** メニューから **Duplicate this Space** を選びます。Visibility（公開 / 非公開）と Hardware（GPU）を選びます。
3. **ゲート付きモデルの利用規約に同意する**：Space が使うモデルがゲート付きの場合は、モデルのページを開き、**Space の持ち主のアカウント**でログインした状態で利用規約に同意します。同意すると、モデルのページに「You have been granted access to this model」と表示されます。
4. **Space にトークンを登録する**：ゲート付きモデルを使う Space では、複製した Space の **Settings → Variables and secrets → New secret** で、Name を `HF_TOKEN`、Value を Read 権限のトークンにして登録します。複製するときに表示される入力欄を空のままにした場合は、ここで登録してください。シークレットは Space ごとに必要です。
5. **アプリに Space の ID を入力する**：アプリの **AI Settings → Hugging Face Spaces** の該当する欄に、複製した Space の ID（`自分のユーザー名/Space名`）を入力します。
6. **使い終わったら止める**：専用 GPU は起動している間ずっと時間課金されます。Space の **Settings** で **Pause** を押して一時停止してください。**Sleep time** を設定しておくと、使われていないときに自動で停止します。

### Space ごとの注意

| Space | GPU の目安 | 必要な準備 |
|---|---|---|
| BRIA RMBG 3.0（`briaai/BRIA-RMBG-3.0`） | **L40S**（48GB）以上 | `briaai/RMBG-3.0` と `briaai/Fibo-2.0-edit-turbo` の利用規約に同意。シークレット `HF_TOKEN` |
| BRIA RMBG 2.0（`briaai/BRIA-RMBG-2.0`） | **T4** | `briaai/RMBG-2.0` の利用規約に同意。シークレット `HF_TOKEN` |
| Depth Anything V2（`depth-anything/Depth-Anything-V2`） | **T4** | なし |
| TRELLIS.2（`microsoft/TRELLIS.2`） | **A100** | なし |
| Hunyuan3D-2.1（`tencent/Hunyuan3D-2.1`） | **A100** | ファイルの修正が必要（下記） |

- **RMBG 3.0** は約 25GB（bf16 の重み）の拡散モデルです。T4 や 24GB の GPU ではメモリが不足します。T4 で使う場合は、AI Settings の **Background removal** で **RMBG 2.0** を選び、RMBG 2.0 の Space を複製してください。
- **TRELLIS.2** は、開発元が 24GB 以上を必要とし、A100 / H100 でのみ動作を確認しています。Space は特定の GPU 向けにビルド済みの CUDA 拡張機能を読み込むため、それより小さい GPU や種類の違う GPU では動かないことがあります。
- **背景除去の Space** は、Gemini で補完する場合にだけ使います。OpenAI で補完すると最初から透明背景で返るので、背景除去の Space は不要です。

### Hunyuan3D-2.1 の複製に必要な修正

公式の Hunyuan3D-2.1 Space は ZeroGPU 用に作られているため、複製して専用 GPU で動かすには、次の修正が必要です。いずれも、複製した Space の **Files** でファイルを開き、**Edit** から直接編集できます。

**`README.md`**（先頭の `---` で囲まれた部分）

```yaml
sdk_version: 5.33.0
python_version: "3.10"
```

`sdk_version` を `requirements.txt` の Gradio の版（5.33.0）に合わせ、`python_version` を追加します。`"3.10"` は引用符で囲んでください。囲まないと YAML が 3.1 と読み取ります。Python 3.10 は、開発元が動作を確認している版です。

**`requirements.txt`**

- 先頭に次の2行を追加します。開発元が動作を確認している torch の版です。固定しないと最新版が入ります。

  ```
  torch==2.5.1
  torchvision==0.20.1
  ```

- 次の2行を削除します。`bpy==4.0` は今の PyPI になく、Blender のサイトからも取得できません。また、Gradio アプリの処理では使われていません。

  ```
  --extra-index-url https://download.blender.org/pypi/
  bpy==4.0
  ```

- ファイル末尾の `pydantic==2.10.6` を `pydantic>=2.11,<2.12` に変えます（Gradio 5.33.0 と、ビルド時に自動で入る `gradio[mcp]` の両方の条件を満たすため）。

**`hy3dpaint/DifferentiableRenderer/mesh_utils.py`**（17行目）

```python
try:
    import bpy  # only used by convert_obj_to_glb, which the Gradio app does not call
except ImportError:
    bpy = None
```

**`gradio_app.py`**（2か所）

(1) `prepare_env()` の中の、ビルド済みの `custom_rasterizer` を入れる行を、ソースからコンパイルする2行に置き換えます。ビルド済みのファイルは、どの torch の版でも正しく動きません（torch 2.5.1 では `undefined symbol`、新しい torch では `tensor does not have a device` のエラーになります）。インデントは元の行に合わせてください。

```python
        # 元の行（削除）
        subprocess.run(shlex.split("pip install custom_rasterizer-0.1-cp310-cp310-linux_x86_64.whl"), check=True)
```

```python
        # 置き換える2行
        os.environ.setdefault("TORCH_CUDA_ARCH_LIST", "8.0")
        subprocess.run(shlex.split("pip install --no-build-isolation /home/user/app/hy3dpaint/packages/custom_rasterizer"), check=True)
```

`--no-build-isolation` は必須です。付けないと、pip がコンパイル用に最新の torch を別に入れてしまい、また版がずれます。`"8.0"` は A100 向けの指定です。

(2) `uvicorn.run(...)` の直前にある、ZeroGPU 専用の起動処理をコメントアウトします。55行目の `ENV = "Huggingface"` は変えないでください。起動時の `custom_rasterizer` のインストールにも使われています。

```python
    # if ENV == 'Huggingface':
    #     # for Zerogpu
    #     from spaces import zero
    #     zero.startup()
```

起動のたびに `custom_rasterizer` などのコンパイルが行われるので、起動には数分かかります。ログに `Successfully installed custom-rasterizer-0.1` が出れば、コンパイルは成功しています。ビルド画面に「A newer version of the Gradio SDK is available」と出ても、**Upgrade は押さないでください**。

## 4. よくあるエラー

| エラーメッセージ | 原因 | 対処 |
|---|---|---|
| `GatedRepoError: 401` / `Please log in` | Space にトークンが登録されていない | シークレット `HF_TOKEN` を登録して再起動 |
| `GatedRepoError: 403` | モデルの利用規約に同意していない | Space の持ち主のアカウントで利用規約に同意 |
| `CUDA out of memory` | GPU のメモリ不足 | 大きい GPU に変更（RMBG 3.0 なら L40S 以上）。または RMBG 2.0 を使う |
| `Scheduling failure: not enough hardware` | 選んだ GPU に空きがない | 時間をおいて再起動するか、別の GPU を選ぶ |
| `No module named 'distutils'` | Python の版が新しすぎる | `README.md` に `python_version` を指定 |
| `Cannot install gradio==4.44.0 and gradio==5.33.0` | `sdk_version` と `requirements.txt` の Gradio の版が違う | `sdk_version` を `requirements.txt` に合わせる |
| `No matching distribution found for bpy==4.0` | bpy 4.0 を取得できない | `requirements.txt` から bpy を削除し、`mesh_utils.py` を修正 |
| `assert Config.zero_device_api_url is not None` | ZeroGPU 専用の処理が呼ばれている | `gradio_app.py` の `zero.startup()` をコメントアウト |
| `tensor does not have a device` / `undefined symbol: _ZN3c10…` | ビルド済みの `custom_rasterizer` が torch の版と合わない | `gradio_app.py` で `custom_rasterizer` をソースからコンパイル |
| アプリで ZeroGPU の利用枠の超過 | 公式 Space の1日の枠を使い切った | 翌日まで待つ、PRO にする、または Space を複製 |

## ライセンス

BRIA RMBG のモデルは非商用利用（CC BY-NC 4.0）として公開されています。Hunyuan3D-2.1 は Tencent Hunyuan 3D 2.1 Community License で、EU、英国、韓国では利用できません。商用で使う場合や、これらの地域で使う場合は、各モデルのライセンスを確認してください。
