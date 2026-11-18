# Preparing and duplicating Hugging Face Spaces

[日本語](hugging-face-spaces-jp.md)

The app calls Hugging Face Spaces for background removal, depth estimation and 3D generation. This document lists what you need to do for that, both for using the official Spaces as they are and for duplicating them to your account to run on a dedicated GPU.

## 1. Get a Hugging Face token

1. Create an account on [huggingface.co](https://huggingface.co/) and sign in.
2. In **Settings → Access Tokens**, click **Create new token** and create a **Read** token (it starts with `hf_`).
3. Enter it in the **HF Token** field at the top right of the app.

With a token, ZeroGPU usage of the official Spaces is counted against your own account's quota. A token is required for 3D generation with TRELLIS.2 and Hunyuan3D-2.1, and for private Spaces (it needs read access to them). The token is kept in memory only and is not stored in the browser. To set it on startup, put it in `VITE_HF_TOKEN` in `.env.local`.

## 2. Use the official Spaces as they are

The official Spaces run on ZeroGPU and need no setup, but each user has a daily quota (larger with Hugging Face PRO). When it runs out, wait until the next day or duplicate the Space as below.

## 3. Duplicate a Space to run it on a dedicated GPU

### Common steps

1. **Add a payment method**: dedicated GPUs are paid. Add one in **Settings → Billing**.
2. **Duplicate the Space**: on the official Space's page, choose **Duplicate this Space** from the **⋮** menu at the top right, and pick the visibility (public / private) and the hardware (GPU).
3. **Accept the terms of gated models**: if the Space uses a gated model, open the model's page while signed in **as the owner of the Space** and accept its terms. The model page then shows "You have been granted access to this model".
4. **Give the Space a token**: for Spaces that use gated models, open **Settings → Variables and secrets → New secret** of your duplicate and add a secret named `HF_TOKEN` whose value is a Read token. Do this if you left the field empty when duplicating. Each Space needs its own secret.
5. **Enter the Space ID in the app**: in **AI Settings → Hugging Face Spaces**, enter the ID of your duplicate (`your-name/Space-name`) in the matching field.
6. **Stop it when you are done**: a dedicated GPU is billed per hour for as long as the Space runs. Click **Pause** in the Space's **Settings**. Setting a **Sleep time** stops it automatically when idle.

### Notes per Space

| Space | GPU | What else is needed |
|---|---|---|
| BRIA RMBG 3.0 (`briaai/BRIA-RMBG-3.0`) | **L40S** (48 GB) or larger | Accept the terms of `briaai/RMBG-3.0` and `briaai/Fibo-2.0-edit-turbo`; secret `HF_TOKEN` |
| BRIA RMBG 2.0 (`briaai/BRIA-RMBG-2.0`) | **T4** | Accept the terms of `briaai/RMBG-2.0`; secret `HF_TOKEN` |
| Depth Anything V2 (`depth-anything/Depth-Anything-V2`) | **T4** | Nothing |
| TRELLIS.2 (`microsoft/TRELLIS.2`) | **A100** | Nothing |
| Hunyuan3D-2.1 (`tencent/Hunyuan3D-2.1`) | **A100** | File changes (below) |

- **RMBG 3.0** is a diffusion model of about 25 GB (bf16 weights); a T4 or 24 GB GPU runs out of memory. To use a T4, select **RMBG 2.0** under **Background removal** in AI Settings and duplicate the RMBG 2.0 Space.
- **TRELLIS.2**: the authors require at least 24 GB and verified only A100/H100, and the Space loads CUDA extensions prebuilt for specific GPUs, so smaller or different GPUs may fail.
- **Background-removal Spaces** are only used after Gemini completion. OpenAI returns completions with a transparent background, so no background-removal Space is needed then.

### Changes needed to duplicate Hunyuan3D-2.1

The official Hunyuan3D-2.1 Space is built for ZeroGPU. To run a duplicate on a dedicated GPU, make the following changes. Each file can be edited directly under **Files → Edit** of your duplicate.

**`README.md`** (the block between the `---` lines at the top)

```yaml
sdk_version: 5.33.0
python_version: "3.10"
```

Match `sdk_version` to the Gradio version in `requirements.txt` (5.33.0) and add `python_version`. Quote `"3.10"`, otherwise YAML reads it as 3.1. Python 3.10 is the version the authors tested.

**`requirements.txt`**

- Add these two lines at the top. This is the torch version the authors tested; without a pin the latest version is installed.

  ```
  torch==2.5.1
  torchvision==0.20.1
  ```

- Remove these two lines. `bpy==4.0` is no longer on PyPI and cannot be fetched from Blender's site, and the Gradio app does not use it.

  ```
  --extra-index-url https://download.blender.org/pypi/
  bpy==4.0
  ```

- Change `pydantic==2.10.6` at the end of the file to `pydantic>=2.11,<2.12` (required by both Gradio 5.33.0 and `gradio[mcp]`, which the build adds).

**`hy3dpaint/DifferentiableRenderer/mesh_utils.py`** (line 17)

```python
try:
    import bpy  # only used by convert_obj_to_glb, which the Gradio app does not call
except ImportError:
    bpy = None
```

**`gradio_app.py`** (two places)

(1) In `prepare_env()`, replace the line that installs the prebuilt `custom_rasterizer` with two lines that compile it from source. The prebuilt file does not work with any torch version tried (`undefined symbol` with torch 2.5.1, `tensor does not have a device` with newer torch). Keep the indentation of the original line.

```python
        # original line (remove)
        subprocess.run(shlex.split("pip install custom_rasterizer-0.1-cp310-cp310-linux_x86_64.whl"), check=True)
```

```python
        # replacement
        os.environ.setdefault("TORCH_CUDA_ARCH_LIST", "8.0")
        subprocess.run(shlex.split("pip install --no-build-isolation /home/user/app/hy3dpaint/packages/custom_rasterizer"), check=True)
```

`--no-build-isolation` is required; without it pip installs the latest torch just for the build, and the versions differ again. `"8.0"` targets the A100.

(2) Just before `uvicorn.run(...)`, comment out the ZeroGPU-only startup. Do not change `ENV = "Huggingface"` on line 55; it also drives the `custom_rasterizer` install on startup.

```python
    # if ENV == 'Huggingface':
    #     # for Zerogpu
    #     from spaces import zero
    #     zero.startup()
```

`custom_rasterizer` and other extensions are compiled on every startup, so it takes several minutes. `Successfully installed custom-rasterizer-0.1` in the log means the compile succeeded. If the build page says "A newer version of the Gradio SDK is available", **do not click Upgrade**.

## 4. Common errors

| Error message | Cause | Fix |
|---|---|---|
| `GatedRepoError: 401` / `Please log in` | The Space has no token | Add the `HF_TOKEN` secret and restart |
| `GatedRepoError: 403` | The model's terms are not accepted | Accept them as the owner of the Space |
| `CUDA out of memory` | Not enough GPU memory | Use a larger GPU (L40S or larger for RMBG 3.0), or use RMBG 2.0 |
| `Scheduling failure: not enough hardware` | No free GPU of that type | Restart later or pick another GPU |
| `No module named 'distutils'` | Python is too new | Set `python_version` in `README.md` |
| `Cannot install gradio==4.44.0 and gradio==5.33.0` | `sdk_version` differs from the Gradio version in `requirements.txt` | Match `sdk_version` to `requirements.txt` |
| `No matching distribution found for bpy==4.0` | bpy 4.0 cannot be fetched | Remove bpy from `requirements.txt` and change `mesh_utils.py` |
| `assert Config.zero_device_api_url is not None` | ZeroGPU-only code runs | Comment out `zero.startup()` in `gradio_app.py` |
| `tensor does not have a device` / `undefined symbol: _ZN3c10…` | The prebuilt `custom_rasterizer` does not match torch | Compile `custom_rasterizer` from source in `gradio_app.py` |
| ZeroGPU quota exceeded (in the app) | The daily quota of an official Space is used up | Wait until the next day, use PRO, or duplicate the Space |

## Licenses

BRIA RMBG models are released for non-commercial use (CC BY-NC 4.0). Hunyuan3D-2.1 is under the Tencent Hunyuan 3D 2.1 Community License, which does not apply in the EU, the UK and South Korea. Check each model's license before commercial use or use in those regions.
