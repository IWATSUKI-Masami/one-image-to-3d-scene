# Roadmap

[日本語](roadmap-jp.md)

Planned extensions. Facts below were checked in November 2026.

## Implemented

Items of earlier versions of this roadmap that are now in the app (see the README for how to use them):

- **Orientation estimation** (first version): **Estimate Orientation** in the 3D Scene header rotates each model about the vertical axis using [Orient Anything](https://huggingface.co/spaces/Viglong/Orient-Anything) (`services/orientation.ts`). Improvements: item 4.
- **Perspective placement**: the **Perspective** checkbox back-projects the point cloud, PC Boxes and models through a pinhole camera, so near objects are no longer magnified. Remaining assumptions: item 5.

## 1. Pixal3D as a 3D generator (Hugging Face Space)

[Pixal3D](https://huggingface.co/TencentARC/Pixal3D) (Tencent ARC, SIGGRAPH 2026, MIT license) is an image-to-3D model that outputs a mesh with PBR textures (GLB).

### Why it suits this system

Most 3D generators build the shape in a canonical space, so the correspondence between image pixels and the 3D model is loose. Pixal3D uses **pixel-aligned generation**: it back-projects pixels to 3D (with the camera field of view estimated by MoGe), so **the front of the generated model matches the input image one-to-one**.

This system scales and places each model so that the object region in the completed image (tightBox2d) matches its PC Box (paper, Section 3.5.3). A model whose front matches the input image should make this alignment more accurate.

### How

- The official Space [TencentARC/Pixal3D](https://huggingface.co/spaces/TencentARC/Pixal3D) is running on ZeroGPU and exposes API endpoints `preprocess`, `generate_3d` and `extract_glb_api` — the same structure as TRELLIS.2, so it can be added the same way (no local GPU needed).
- Things to check when implementing: parameters of `generate_3d`, the model orientation in the scene, and the alignment with tightBox2d.

### Fitting to the point cloud

Pixal3D could also give position, orientation and size together, when combined with registration to the point cloud:

1. **Initial pose from Pixal3D**: if the model is generated in the frame of the input image's camera, its orientation relative to the camera is already correct, and Orient Anything (item 4) would no longer be needed.
2. **Visible surface**: take the part of the model visible from that camera.
3. **Registration**: fit that surface to the object's masked point cloud (from the depth map) with a similarity transform (scale, rotation, translation; ICP / Umeyama). This gives position, size and fine orientation at once. ICP fails from a poor initial orientation; Pixal3D's alignment provides a good one. Since only the visible surfaces are matched, it may also help partially visible objects (item 3).

To check first:

- Whether the output GLB stays in the camera frame or is normalized in size and position.
- The input is the completed crop, not the original photo. The crop's position in the photo gives the camera transform, but the image model may redraw or re-center the object during completion.
- The point cloud depends on the assumptions of item 5 (field of view, far/near ratio).

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

### Approach (adopted): fit the model by rendering it

Render the 3D model from the photo's camera and search for the position, size and rotation (about the vertical axis) at which the rendering does not contradict the photo (analysis-by-synthesis). Which part of the model is visible then follows from the fit. Only physical conditions that hold in any scene are used — no rules per object category.

Cues from the photo: the mask of the object's visible pixels, the depth map, the masks and depths of the other objects (what is in front), and the image border (beyond it nothing is seen).

Conditions:

1. **Cover the visible part**: every pixel of the object's mask is covered by the rendered model.
2. **No unexplained absence**: where the model would be drawn inside the image but the photo shows something farther away (e.g. the wall), the placement is wrong. Behind a nearer object and outside the image the model may extend freely.
3. **Matching depth**: on the visible part, the model's surface depth agrees with the depth map (weighted lightly, because the depth is relative and the camera is assumed; see item 5).
4. **Semantic correspondence** (later stage): match the same parts (e.g. "top of the backrest", "legs") between the photo and the rendering, with image features (e.g. DINOv2) or by asking a VLM for corresponding points. This works even when the generated model's colors differ from the photo.

Initial values: orientation from Orient Anything, size from fully visible objects (people) and typical sizes, depth from the median of the visible part. Then a coarse search and a local refinement on small renderings (e.g. 128 px) in the browser.

Stages:

1. **Object masks** — **done**: SAM 2.1 in the browser (transformers.js), prompted with each detected box (**Segment Objects**). The masks are also used for each object's depth (Eq. (4)).
2. **Fitting with conditions 1–3** — **done (first version)**: models whose mask touches the image border are fitted (**Fit Partial Objects**), with a size prior from the VLM's typical real heights scaled by the objects inside the image. On synthetic scenes with known poses, positions were within about 1–12% of the viewing distance. Open points: the rotation of a barely visible object is often not determined (condition 4 or the orientation estimate could help); objects hidden only by other objects (not cut by the border) are not yet selected; gravity (standing on the floor) is not used; fitting runs on the main thread (a few seconds per object).
3. **Semantic correspondence** (condition 4): compare DINOv2 in the browser with VLM-based correspondence.
4. **Evaluation** on several photos with partially visible objects, with the same settings, so that the method is not tuned to the sample.

## 4. More accurate orientation estimation

A first version is implemented (see "Implemented" above): Orient Anything on the photo appearance and on a front render of each model, plus a viewing-direction correction. Ways to improve it:

- **Use the depth map**: detect left/right point pairs in 2D, such as a person's shoulders (pose estimation, e.g. MediaPipe), and read their depth from the depth map. The depth difference gives the body's yaw, independently of Orient Anything.
- **Ask the vision model (VLM)**: give the crop to OpenAI / Gemini and ask, with structured output (e.g. in 15° steps), which direction the subject faces. Useful as a cross-check.
- **Render and compare**: render the generated model at several yaw angles (e.g. every 10°) and pick the angle whose silhouette or appearance best matches the masked crop. Works for any object but costs more computation.
- **Orient Anything V2** ([Space](https://huggingface.co/spaces/Viglong/Orient-Anything-V2), ZeroGPU) also returns the relative azimuth of two images and the symmetry of the object (number of directions), which could replace the two separate estimates and the confidence threshold.
- **Evaluation**: compare against hand-set angles on a set of photos.

## 5. Camera and depth calibration

Perspective placement (see "Implemented" above) still relies on two assumptions:

- **Field of view**: 60° horizontal is assumed. It could be read from EXIF or estimated with a model such as MoGe, which estimates camera intrinsics.
- **Far/near distance ratio**: Depth Anything V2's relative disparity is stretched over the full range for every image, so the ratio is unknown and set with the Depth slider (default 1.5, tuned on the sample photo). A metric depth model (e.g. Depth Anything V2 Metric, Depth Pro, MoGe) would give real distances, or the ratio could be estimated from typical object sizes (a cup, a person's head) in the scene.

The orientation estimation's viewing-direction correction uses the same field of view, so it would benefit as well.

## 6. Better faces of people

### Problem

Faces of the 3D models of people look unnatural (uncanny).

### Cause

- In the completed full-body image (1024×1536), the face covers only a few dozen pixels.
- General image-to-3D models (TRELLIS.2, Hunyuan3D-2.1) cannot reproduce the relief of a face (eye sockets, nose, mouth) at that size, so the result is a smooth shape with eyes and mouth painted on. TRELLIS.2 already runs near its limits (resolution 1024, texture 2048).
- People are detected as `type: 'person'`, but completion and 3D generation treat them like any other object.

### Ideas (in the suggested order)

1. **Person-specific completion prompt**: for `person` only, ask for a clear, natural face (facing forward, eyes open, calm expression). Cheap, but a blurred face in the photo is redrawn, so it will not look like the actual person.
2. **TRELLIS.2 resolution 1536**: slightly finer shape, at the cost of generation time and ZeroGPU quota.
3. **Face restoration before 3D generation**: sharpen the face of the completed image with a face restoration model (e.g. CodeFormer) on another Space.
4. **Not modelling the face**: blur the face texture or fill it with the skin color ("mannequin" look). This removes the uncanny effect and may be enough for scene reconstruction.
5. **Human-specific 3D generators** (e.g. PSHuman, LHM, based on a human body model): best quality, but availability as a Space and licenses need checking.

**Status**: 1, 2 and 4 are implemented as the **Face** completion option (Calm / Redraw / Mannequin / As in photo) and the higher resolution for people (also octree resolution 384 for Hunyuan3D-2.1). Redraw alone still looked uncanny on the sample, mainly because of open mouths with teeth, so **Calm** (closed mouth) is the default. Next, if needed: 3 or 5.

## References

- [ComfyUI Docs: Pixal3D](https://docs.comfy.org/tutorials/3d/pixal3d)
- [ComfyUI Docs: TRELLIS.2](https://docs.comfy.org/tutorials/3d/trellis2)
- [ComfyUI Docs: Hunyuan3D 2.0 and 2.1](https://docs.comfy.org/tutorials/3d/hunyuan3D-2)
- [ComfyUI Docs: TripoSplat](https://docs.comfy.org/tutorials/3d/triposplat)
- [Hugging Face: TencentARC/Pixal3D (model)](https://huggingface.co/TencentARC/Pixal3D), [(Space)](https://huggingface.co/spaces/TencentARC/Pixal3D)
- [TRELLIS.2 native vs legacy VRAM guide](https://book.st-hakky.com/en/data-science/trellis2-native-vs-legacy-vram-guide)
