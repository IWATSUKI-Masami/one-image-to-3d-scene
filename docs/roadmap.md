# Roadmap

[日本語](roadmap-jp.md)

Planned extensions that are not implemented yet. Facts below were checked in November 2026.

## 1. Pixal3D as a 3D generator (Hugging Face Space)

[Pixal3D](https://huggingface.co/TencentARC/Pixal3D) (Tencent ARC, SIGGRAPH 2026, MIT license) is an image-to-3D model that outputs a mesh with PBR textures (GLB).

### Why it suits this system

Most 3D generators build the shape in a canonical space, so the correspondence between image pixels and the 3D model is loose. Pixal3D uses **pixel-aligned generation**: it back-projects pixels to 3D (with the camera field of view estimated by MoGe), so **the front of the generated model matches the input image one-to-one**.

This system scales and places each model so that the object region in the completed image (tightBox2d) matches its PC Box (paper, Section 3.5.3). A model whose front matches the input image should make this alignment more accurate.

### How

- The official Space [TencentARC/Pixal3D](https://huggingface.co/spaces/TencentARC/Pixal3D) is running on ZeroGPU and exposes API endpoints `preprocess`, `generate_3d` and `extract_glb_api` — the same structure as TRELLIS.2, so it can be added the same way (no local GPU needed).
- Things to check when implementing: parameters of `generate_3d`, the model orientation in the scene, and the alignment with tightBox2d.

## 2. Local 3D generation with ComfyUI

Add **ComfyUI (local)** as an option for 3D generation, next to the Hugging Face Spaces. The Spaces stay the default, because most users do not have a suitable GPU.

### Why

- **No ZeroGPU quota or Hugging Face token**: generation runs on the user's own GPU, with stable waiting times.
- **Reproducibility**: the model and workflow versions can be pinned, which suits experiments that reproduce the paper.
- **Privacy**: images never leave the user's machine.
- **More models through one interface**: switching models means switching workflow files.

### Candidate models

From the ComfyUI documentation.

| Model | In ComfyUI | Output | Fit for this app |
|---|---|---|---|
| Pixal3D | Core nodes. Template "Pixal3D & TRELLIS.2: Image to Model" | Mesh with PBR textures (GLB) | Good (see section 1) |
| TRELLIS.2 | Core nodes, in the same template (switch with `Boolean (Switch to Trellis2)`) | Mesh with PBR textures (GLB) | Good |
| Hunyuan3D 2.0 / 2.1 | Core nodes generate **shape only (untextured)** | Mesh (GLB) | Weaker than the Hunyuan3D-2.1 Space, which returns a textured GLB |
| TripoSplat | Core nodes | **Gaussian splats**; optional `SplatToMesh` conversion to GLB | Low priority (see below) |

This app loads models as GLB meshes, scales and offsets them from their mesh bounding box to match the PC Box (Eq. (10), (11) of the paper), and exports the scene as glTF/GLB. TripoSplat's main output, Gaussian splats, does not fit this. Its optional mesh conversion can produce a GLB, but a converted mesh is unlikely to beat models that generate meshes directly (Pixal3D, TRELLIS.2).

### Design sketch

- Settings: ComfyUI address (default `http://127.0.0.1:8188`) and a workflow file in **API format** (exported from ComfyUI).
- Ship the Pixal3D / TRELLIS.2 workflow in the repository.
- Call sequence (ComfyUI HTTP API):
  1. `POST /upload/image` — upload the completed, background-removed image
  2. `POST /prompt` — submit the workflow with the uploaded file name set in its `LoadImage` node
  3. Poll `GET /history/{prompt_id}` until the job finishes
  4. `GET /view?filename=…` — download the GLB written by the save node
- The Pixal3D workflow has its own background removal (BiRefNet) and can skip it with a switch; our input is already background-removed.
- Reuse the existing placement logic; set the model orientation per workflow.

### Constraints

- **NVIDIA GPU required**: about 6–12 GB VRAM for Hunyuan3D 2.0 (shape / shape + texture), about 24 GB recommended for TRELLIS.2 (third-party guide). The Pixal3D page does not state a figure.
- **Model downloads**: Pixal3D needs its diffusion model plus the TRELLIS.2 shape/texture VAEs, DINOv3, MoGe and BiRefNet.
- **Browser access**: ComfyUI must be started with `--enable-cors-header` so that the app can call it from the browser.
- **Maintenance**: workflow files may need updates when ComfyUI renames nodes.
- **Testing**: needs a machine with a GPU (it cannot be tested in a CPU-only environment).

## 3. Placing partially visible objects

### Problem

Objects of which only a small part is visible in the photo — the table (only the front edge of the top) and the chairs (thin strips at the image borders) in the sample — end up much too small in the 3D scene.

### Cause

1. The image model redraws the whole object during completion, so the visible part cannot be found in the completed image by feature matching (AKAZE finds almost no matching keypoints).
2. The matching then falls back to the box of the whole object (tightBox2d).
3. The whole 3D model is therefore scaled to fit the small box of the visible part in the photo.

People, the vase and the cups are mostly visible and are placed correctly.

### Ideas

- **Ask the VLM where the visible part is**: when matching fails, give the crop and the completed image to the vision model (Gemini / OpenAI) and ask for the box of the crop's content in the completed image.
- **Use the completion canvas**: before completion the crop is placed at a known position on a larger white canvas (`prepareImageForCompletion`). If the image model keeps that layout, the expected position can be derived from it; the result must be checked, because models often re-center the object.
- **Size priors**: use typical real-world sizes per category (e.g. a dining chair seat at about 0.45 m) relative to the people in the scene to bound the scale.
- **Silhouette fitting**: render the 3D model from the estimated camera and fit its scale and position so that its silhouette matches the visible mask in the photo.
- **Pixel-aligned generation**: models such as Pixal3D (item 1) keep the front of the model aligned with the input image, which may make the visible part easier to locate.

## 4. Estimating orientation (rotation about the vertical axis)

### Problem

The depth position of people and objects is roughly right, but **their orientation is not corrected**. In the 3D scene every model keeps the orientation its generator treats as the front (zero rotation about the vertical axis). Two people talking face to face in the photo can therefore face the same direction in the scene. Today the only fix is rotating them by hand in Edit mode.

### Goal

Estimate from the photo where a person is facing (**face and body**), or where an object's **characteristic part** points (a chair's backrest, a cup's handle), compute the **rotation about the vertical (Y) axis**, and apply it when placing the model.

### Ideas

- **Viewing-direction correction (first step)**: TRELLIS.2 and Hunyuan3D-2.1 roughly reproduce the input view as the model's front, but an object away from the image center is seen from an angle. Rotating the model by the horizontal angle from the camera to the object (`atan2(x, z)`) brings it closer to how it looks in the photo. A simple baseline that needs no extra model.
- **Use the depth map**: detect left/right point pairs in 2D, such as a person's shoulders (pose estimation, e.g. MediaPipe), and read their depth from the depth map. The depth difference gives the body's yaw. For objects, the depth difference between the left and right ends may give it as well.
- **Ask the vision model (VLM)**: give the crop to Gemini / OpenAI and ask, with structured output (e.g. in 15° steps), which direction the subject faces relative to the camera. Easy to implement; the angle may be coarse.
- **A dedicated orientation model**: call a model that estimates an object's orientation (azimuth etc.) from one image, such as Orient Anything, e.g. through a Hugging Face Space. Available Spaces or APIs need to be checked when implementing.
- **Render and compare**: render the generated model from the scene camera at several yaw angles (e.g. every 10°) and pick the angle whose silhouette or appearance best matches the masked crop. Works for any object but costs more computation.

### Things to watch

- **The front of each generator**: generators may differ in which direction of the model they treat as the front; check each one so that the correction has a common reference.
- **Order relative to scaling**: rotation changes the width and depth of the model's bounding box, so the scale fit to the PC Box (Eq. (10), (11) of the paper) must be computed after the rotation is applied.
- **Evaluation**: compare methods against hand-set angles or against how well the rendered view matches the photo.

## References

- [ComfyUI Docs: Pixal3D](https://docs.comfy.org/tutorials/3d/pixal3d)
- [ComfyUI Docs: TRELLIS.2](https://docs.comfy.org/tutorials/3d/trellis2)
- [ComfyUI Docs: Hunyuan3D 2.0 and 2.1](https://docs.comfy.org/tutorials/3d/hunyuan3D-2)
- [ComfyUI Docs: TripoSplat](https://docs.comfy.org/tutorials/3d/triposplat)
- [Hugging Face: TencentARC/Pixal3D (model)](https://huggingface.co/TencentARC/Pixal3D), [(Space)](https://huggingface.co/spaces/TencentARC/Pixal3D)
- [TRELLIS.2 native vs legacy VRAM guide](https://book.st-hakky.com/en/data-science/trellis2-native-vs-legacy-vram-guide)
