# Roadmap

[日本語](roadmap-jp.md)

Planned extensions that are not implemented yet.

## Local 3D generation with ComfyUI

Add **ComfyUI (local)** as a third option for 3D generation, next to the Hugging Face Spaces (TRELLIS.2 and Hunyuan3D-2.1). The Spaces stay the default, because most users do not have a suitable GPU.

### Why

- **No ZeroGPU quota or Hugging Face token**: generation runs on the user's own GPU, with stable waiting times.
- **Reproducibility**: the model and workflow versions can be pinned, which suits experiments that reproduce the paper.
- **Privacy**: images never leave the user's machine.
- **More models through one interface**: switching models means switching workflow files.

### Candidate models

Checked against the ComfyUI documentation (2026-11).

| Model | In ComfyUI | Output | Fit for this app |
|---|---|---|---|
| TRELLIS.2 | Core (native) nodes | Mesh with PBR textures | Good |
| Pixal3D | Core (native) nodes | Mesh | To be evaluated |
| Hunyuan3D-2 | Core nodes generate **shape only**; textures need a custom node | Mesh | Weaker than the Hunyuan3D-2.1 Space, which returns textured GLB |
| TripoSplat | — | **Gaussian splats** | Not usable (see below) |

Gaussian-splat models do not fit this app: models are loaded as GLB meshes, scaled and offset from their mesh bounding box to match the PC Box (Eq. (10), (11) of the paper), and exported as glTF/GLB. Supporting splats would need a separate renderer, a bounding box computed from the splat distribution, and a non-GLB export format.

### Design sketch

- Settings: ComfyUI address (default `http://127.0.0.1:8188`) and a workflow file in **API format** (exported from ComfyUI).
- Ship a TRELLIS.2 workflow in the repository.
- Call sequence (ComfyUI HTTP API):
  1. `POST /upload/image` — upload the completed, background-removed image
  2. `POST /prompt` — submit the workflow with the uploaded file name set in its image loader node
  3. Poll `GET /history/{prompt_id}` until the job finishes
  4. `GET /view?filename=…` — download the GLB from the save node
- Reuse the existing placement logic; set the model orientation per workflow (TRELLIS.2 needs no rotation).

### Constraints

- **NVIDIA GPU required**: about 6–12 GB VRAM for Hunyuan3D-2 (shape / shape + texture), about 24 GB recommended for TRELLIS.2.
- **Browser access**: ComfyUI must be started with `--enable-cors-header` so that the app can call it from the browser.
- **Maintenance**: workflow files may need updates when ComfyUI renames nodes.
- **Testing**: needs a machine with a GPU (it cannot be tested in a CPU-only environment).

### References

- [ComfyUI Docs: TRELLIS.2](https://docs.comfy.org/tutorials/3d/trellis2)
- [ComfyUI Docs: Hunyuan3D-2](https://docs.comfy.org/tutorials/3d/hunyuan3d-2)
- [ComfyUI Docs: TripoSplat](https://docs.comfy.org/tutorials/3d/triposplat)
- [ComfyUI Blog: TRELLIS.2 and Pixal3D are now native](https://blog.comfy.org/p/trellis2-and-pixal3d-are-now-native)
