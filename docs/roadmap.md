# Roadmap

[日本語](roadmap-jp.md)

Planned extensions. Facts below were checked in November 2026.

## Implemented

Items of earlier versions of this roadmap that are now in the app (see the README for how to use them):

- **Perspective placement**: the **Perspective** checkbox back-projects the point cloud, PC Boxes and models through a pinhole camera, so near objects are no longer magnified. Remaining assumptions: item 5.
- **Placing partially visible objects** (item 3): object masks in the photo (SAM 2.1 in the browser, run automatically after detection), editable annotations (English or Japanese) used in the completion prompt, layout-preserving completion that keeps the visible part at a known box in the completed image (no feature matching needed), and the paper's box placement with that box. The partly visible chairs at the image borders of the sample now stand behind the people.
- **Orientation** (item 4): front alignment turns each model so that its front view matches its completed image (render and compare), and by the view angle; the two people of the sample turn towards each other.
- **Relations between objects** (item 3, first version): **Arrange** lets Claude rearrange the models semantically (supports, seated people, sizes, orientation) by comparing the photo with renderings of the scene, in a few rounds with visual feedback. Not yet evaluated on many photos.
- **Faces of people** (item 6, partly): the **Face** completion option (Calm by default) and a higher 3D resolution for people.

Tried and removed during development: orientation estimation with Orient Anything (replaced by front alignment) and a render-and-fit search over position, size and rotation for partially visible objects (the box placement with the kept part box worked better).

## 1. Pixal3D as a 3D generator (Hugging Face Space)

[Pixal3D](https://huggingface.co/TencentARC/Pixal3D) (Tencent ARC, SIGGRAPH 2026, MIT license) is an image-to-3D model that outputs a mesh with PBR textures (GLB).

### Why it suits this system

Most 3D generators build the shape in a canonical space, so the correspondence between image pixels and the 3D model is loose. Pixal3D uses **pixel-aligned generation**: it back-projects pixels to 3D (with the camera field of view estimated by MoGe), so **the front of the generated model matches the input image one-to-one**.

This system scales and places each model so that the visible part of the completed image (kept through completion) and the whole object (tightBox2d) map onto its PC Box (paper, Section 3.5.3). Front alignment (item 4) now corrects the generator's rotation about the vertical axis, but not other differences between the model's front and the image (proportions, tilt). A pixel-aligned model would make this mapping exact.

### How

- The official Space [TencentARC/Pixal3D](https://huggingface.co/spaces/TencentARC/Pixal3D) is running on ZeroGPU and exposes API endpoints `preprocess`, `generate_3d` and `extract_glb_api` — the same structure as TRELLIS.2, so it can be added the same way (no local GPU needed).
- Things to check when implementing: parameters of `generate_3d`, the model orientation in the scene, and the alignment with tightBox2d.

### Fitting to the point cloud

Pixal3D could also give position, orientation and size together, when combined with registration to the point cloud:

1. **Initial pose from Pixal3D**: if the model is generated in the frame of the input image's camera, its orientation relative to the camera is already correct, without front alignment (item 4).
2. **Visible surface**: take the part of the model visible from that camera.
3. **Registration**: fit that surface to the object's masked point cloud (from the depth map) with a similarity transform (scale, rotation, translation; ICP / Umeyama). This gives position, size and fine orientation at once. ICP fails from a poor initial orientation; Pixal3D's alignment provides a good one. Since only the visible surfaces are matched, it may also help partially visible objects (item 3).

To check first:

- Whether the output GLB stays in the camera frame or is normalized in size and position.
- The input is the completed crop, not the original photo. Layout-preserving completion keeps the visible part at a known box, which with the crop's position in the photo gives the camera transform.
- The point cloud depends on the assumptions of item 5 (field of view, far/near ratio).

## 2. Local 3D generation with ComfyUI

Add **ComfyUI (local)** as an option for 3D generation, next to the Hugging Face Spaces. The Spaces stay the default, because most users do not have a suitable GPU.

### Why

- **No ZeroGPU quota or Hugging Face token**: generation runs on the user's own GPU, with stable waiting times. 3D generation is the slowest step: on the Spaces it took 46–96 s per object (70 s on average) for the sample, about 70% of the whole processing time (about 14 minutes for 8 objects).
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

This app loads models as GLB meshes, scales and offsets them from their mesh bounding box to match the PC Box (Eq. (10), (11) of the paper), and can export the placed models as one GLB file (**GLB** in the scene). TripoSplat's main output, Gaussian splats, does not fit this. Its optional mesh conversion can produce a GLB, but a converted mesh is unlikely to beat models that generate meshes directly (Pixal3D, TRELLIS.2).

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

### Status

Mostly solved (see "Implemented"). Objects of which only a small part is visible used to end up much too small: the image model redrew the whole object during completion, feature matching (AKAZE) could not find the visible part, and the whole model was squeezed into the small box of that part. Now the visible part keeps a known box through completion:

1. **Object masks** (automatic after detection): SAM 2.1 runs in the browser, prompted with each detected box.
2. **Canvas**: the VLM estimates from the whole photo how far the object extends beyond its box on each side; the crop is placed on a canvas of the image model's output size with that room. Only the object's pixels are drawn, and an OpenAI edit mask locks them. The whole photo with the object marked is given as a reference image.
3. **Check**: the visible part is searched for near its box by correlation (small shifts and size changes are corrected); if it moved further, the completion is retried, and AKAZE remains the fallback. The retries cost API credits; **Attempts: 1** completes each object once, for users who adjust the placement by hand (see the README's section on API usage).
4. **Front alignment** (item 4) makes the model's front view match the completed image, so the visible part's box maps onto the right part of the model.

### Remaining

- **Small, featureless visible parts**: the table of the sample, visible only as the front of its top, is still placed only roughly. Its box gives little information about where the rest of the table is. For now it can be corrected by hand in the scene's edit mode (the README shows the sample scene edited this way); scaling now follows the model's own axes, also for turned models (uniformly by default), edits can be undone and redone, and the hand placement can be saved as a small layout file (**Save** in the scene) and loaded again. Hand placements are also saved with the project.
- **Ideas**: ground contact (furniture stands on the floor, estimated from the people's feet), typical sizes relative to the people, or pixel-aligned generation (Pixal3D, item 1) with registration to the point cloud.
- **Hidden shapes guessed wrong**: in a second test photo, an L-shaped desk was described by the VLM as rectangular and completed as a rectangular desk, so the person sitting in the corner of the L intersected it. In the first test photo, an open laptop seen from the back of its screen was described as "closed" and became a box in 3D. The annotations can now be edited (also in Japanese) and the description is part of the completion prompt, so the user can correct such guesses: after editing, an L-shaped desk and an open laptop were generated. Thin objects seen face-on remain hard, because the image-to-3D model sees only the completed image (not the description) and gets no cue for their thickness. **Arrange** (Claude, see "Implemented") now handles such relations semantically with visual feedback; each object's photo match (IoU with its SAM mask, seen from the photo's camera) is now given to Claude and the mean is reported before and after a run; Arrange runs with Claude, OpenAI or Gemini, so the models can be compared, and **📏 Match** saves the photo match of any scene as an image (PNG) and values (CSV). To evaluate on the sample photos: how often it improves the scene (first results: table-talk 0.29 → 0.52 with Claude, cafe-couple 0.34 → 0.73 with OpenAI; each run's report and per-object CSV can be saved), each provider's result, its cost per run, and whether geometric checks (contact, non-intersection computed from the meshes) should be given to it as tool results. Further ideas: contact and non-intersection between objects as constraints on the placement, or several completion candidates of which the one most consistent with the photo is chosen.
- **Evaluation**: three AI-generated photos (the sample and two test photos, all in `samples/`; 23 objects, 13 of them partly visible) — the visible part was kept in place for all 23 objects, with no feature matching. In a rerun of the sample, all 8 objects kept their visible part at the first attempt (placement scores 0.66–0.97). **Stats** in the app exports these figures (attempts, placement scores, alignment) as CSV; more photos, including real ones, are needed.

## 4. Orientation

### Status

Implemented as front alignment (`services/frontAlignment.ts`): each model is rendered around the vertical axis and compared with its completed image (silhouette IoU, aspect ratio, brightness correlation), turned to the best angle, and with perspective also by the view angle. On renderings with known rotations, a chair was recovered within 3° and a cup within about 12°. Turning a model by more than 90° needs a score gain of at least 0.05 over the best forward-facing angle; in the test photos, a desk lamp, desks and a mug that the generator had built facing the other way were still turned around correctly, and a person seen from the side was turned by 74°. This replaced the first version based on Orient Anything.

### Remaining

- **Front/back and mirror ambiguities** of nearly symmetric objects (cups, vases, possibly people seen from the side): the silhouettes of opposite angles are almost the same. A small preference for small turns, and the gain required for turning around, keep such objects as generated; the price is that an object really turned by more than 90° with similar front and back silhouettes is estimated facing forward. Brightness or color features with more weight, a VLM check ("is the model facing the same way as the image?"), or **Orient Anything V2** ([Space](https://huggingface.co/spaces/Viglong/Orient-Anything-V2)), which also estimates an object's symmetry, could resolve them.
- **Rotation about other axes** (tilted objects) is not handled.

## 5. Camera and depth calibration

Perspective placement (see "Implemented" above) still relies on two assumptions:

- **Field of view**: 60° horizontal is assumed. It could be read from EXIF or estimated with a model such as MoGe, which estimates camera intrinsics.
- **Far/near distance ratio**: Depth Anything V2's relative disparity is stretched over the full range for every image, so the ratio is unknown and set with the Depth slider (default 1.5, tuned on the sample photo). A metric depth model (e.g. Depth Anything V2 Metric, Depth Pro, MoGe) would give real distances, or the ratio could be estimated from typical object sizes (a cup, a person's head) in the scene.

The view-angle correction of the front alignment uses the same field of view, so it would benefit as well.

## 6. Better faces of people

### Status

Partly implemented (see "Implemented"). Faces of the 3D models of people looked unnatural (uncanny): in the completed full-body image (1024×1536) the face covers only a few dozen pixels, and general image-to-3D models (TRELLIS.2, Hunyuan3D-2.1) cannot reproduce its relief at that size, so the result was a smooth shape with eyes and mouth painted on.

- **Done**: the **Face** completion option — **Calm** (default; sharp face, closed mouth, since open mouths and teeth looked uncanny), **Redraw**, **Mannequin** (no painted features), **As in photo** — and a higher resolution for people (TRELLIS.2 1536 with texture 4096; Hunyuan3D-2.1 octree 384). Faces are much better, but still not fully natural.

### Remaining

- **Face restoration before 3D generation**: sharpen the face of the completed image with a face restoration model (e.g. CodeFormer) on another Space.
- **Human-specific 3D generators** (e.g. PSHuman, LHM, based on a human body model): best quality, but availability as a Space and licenses need checking.

## References

- [ComfyUI Docs: Pixal3D](https://docs.comfy.org/tutorials/3d/pixal3d)
- [ComfyUI Docs: TRELLIS.2](https://docs.comfy.org/tutorials/3d/trellis2)
- [ComfyUI Docs: Hunyuan3D 2.0 and 2.1](https://docs.comfy.org/tutorials/3d/hunyuan3D-2)
- [ComfyUI Docs: TripoSplat](https://docs.comfy.org/tutorials/3d/triposplat)
- [Hugging Face: TencentARC/Pixal3D (model)](https://huggingface.co/TencentARC/Pixal3D), [(Space)](https://huggingface.co/spaces/TencentARC/Pixal3D)
- [TRELLIS.2 native vs legacy VRAM guide](https://book.st-hakky.com/en/data-science/trellis2-native-vs-legacy-vram-guide)
