# Changelog

All notable changes to this project. Versions up to v1.18.1 were developed in the predecessor (private) repository.


## Unreleased

First version of the public repository. Changes since v1.18.1, the last version of the private predecessor (the history of the private versions follows below, oldest first).

### Added

- **OpenAI as an AI provider** next to Gemini. Object detection/checks and image completion can each use either provider; OpenAI is the default. Providers, API keys, model IDs and Hugging Face Space IDs are set in the new **AI Settings** dialog (an empty Space field means the official Space). Only values that differ from the defaults are stored in the browser, so new defaults take effect.
- **Transparent OpenAI completions**: OpenAI is asked for a transparent background (retried without it if a model rejects it), so OpenAI completion needs no background-removal Space. Completions that are already transparent skip BRIA RMBG.
- **Background-removal choice**: BRIA RMBG 2.0 (`briaai/BRIA-RMBG-2.0`) or 3.0 (`briaai/BRIA-RMBG-3.0`, default), each with its own Space ID field. Only used after Gemini completion; the choice is disabled while OpenAI does the completion. A failed removal is shown on the completed card, and completed images are shown on a light checkerboard so that transparency is visible.
- **Hunyuan3D-2.1** (Tencent, Hugging Face Space) as a 3D generator next to TRELLIS.2. Its license does not apply in the EU, the UK and South Korea.
- **Orientation estimation** (**Estimate Orientation** in the 3D Scene header). [Orient Anything](https://huggingface.co/spaces/Viglong/Orient-Anything) (CPU Space) estimates the viewer's azimuth for the completed image and for a front render of each model; models are rotated about the vertical axis by `view angle + azimuth(model) − azimuth(photo)` before they are scaled to their PC Box. Objects without a clear front (confidence < 0.5) are not rotated. The angles are shown per model, saved with the project, and can be turned off with the **Orientation** checkbox.
- **Perspective placement** in the 3D scene (**Perspective** checkbox, on by default). The point cloud, PC Boxes and models are back-projected through a pinhole camera (assumed 60° horizontal field of view), and the depth map is read as disparity (inverse depth), as Depth Anything V2 outputs it. The **Depth** slider then sets the far/near distance ratio of the scene (default 1.5). Near objects such as cups keep a realistic size relative to people, and the scene starts from the photo's camera, fitted to the canvas. Unchecking it reproduces the paper's placement.
- **Stray-fragment removal**: small fragments far from a model's main body are removed when the model is loaded, so they no longer stretch its bounding box or shrink it in the scene (e.g. a Hunyuan3D-2.1 cup had 14 fragments, 0.1% of its surface, that made its box about 4 times as tall). Nearby separate parts (a saucer, petals) are kept.
- PNG download button on the Depth Map card.
- **More natural faces of people**: with the **Redraw faces** completion option (on by default; next to **Complete** and on the Image Completion card), the completion prompt for people asks for a sharp face with natural proportions (keeping hairstyle, skin tone, age, head direction and expression) instead of copying a blurred face. In addition, people are generated at a higher resolution (TRELLIS.2: resolution 1536 and texture 4096 instead of 1024 and 2048; Hunyuan3D-2.1: octree resolution 384 instead of 256). This takes longer and uses more ZeroGPU quota per person.
- Documentation: a sample photo (`samples/two-people-at-table.webp`, AI-generated) and a walkthrough with screenshots in the README; `docs/hugging-face-spaces.md` (tokens, gated models, the `HF_TOKEN` Space secret, GPU per Space, the changes a Hunyuan3D-2.1 duplicate needs on a dedicated GPU, common errors); `docs/roadmap.md`. All documents in English and Japanese.

### Changed

- Default Gemini models: `gemini-3-pro-preview` → `gemini-pro-latest`, `gemini-3-pro-image-preview` (shut down) → `gemini-3-pro-image`. Gemini calls use the `v1beta` API explicitly (SDK 3.x defaults to `v1`, where such aliases return 404). API keys can be entered in the app; the Google AI Studio key-selection integration was removed.
- JSON output of all vision tasks is enforced with each provider's structured-output feature; the detection result is wrapped as `{"objects": [...]}`.
- AKAZE matching: the homography (8 parameters) is replaced by a RANSAC fit of uniform scale + translation (3 parameters), the completed image is searched at 1, 1/2 and 1/4 scale, and transparent pixels are composited on white. Matches with too few agreeing points or boxes outside the image are rejected, so the whole-object box is used instead. (The paper, Eq. (2), uses a homography.)
- OpenCV.js 4.10.0 is shipped with the app (`@techstark/opencv-js`, pinned) instead of being loaded from `docs.opencv.org/4.x`, which had stopped initializing.
- Tailwind CSS is built with the app (Tailwind v3 + PostCSS) instead of the Play CDN.
- Saved projects are named `<photo name>_<stage>_<YYYYMMDD-HHMMSS>.json`; the photo name is stored in the project.
- Images sent to Hunyuan3D-2.1 are used as they are (no second background removal by the Space), with alpha below about 10% cleared and fully transparent pixels made white. Before, the Space's RGB conversion brought back the hidden background (a slab under the cups), and nearly invisible specks left by background removal (alpha = 1) became a board behind a chair or fragments at the edges of the generation volume.
- Dependencies: `@google/genai` 1.30 → 3.4, `@gradio/client` 2.0 → 2.8; added `openai`; removed the unused `@google/generative-ai`.

### Fixed

- PC Box depth now follows Eq. (4) of the paper: the median depth of the non-transparent pixels (alpha > 128) of the object's background-removed image. This code path had never run; boxes and models were placed using the depth at a few fixed points.
- Hugging Face Spaces could not be called from the browser ("Failed to fetch", CORS): `@gradio/client` 2.0 sent `credentials: 'include'`. The Hugging Face token was never sent (the app passed `hf_token`, the client reads `token`), so ZeroGPU usage was not counted against the user's quota.
- AKAZE matching never ran (OpenCV.js did not load), leaked OpenCV objects and computed the box of projected corners wrongly.
- The 3D scene could stay empty or turn blank: a WebGL context was left behind on every rebuild (the browser drops the visible one after about 16), an earlier initialization (React StrictMode) could clear the current scene's models, and a scene rebuilt while its tab was hidden got a 0×0 canvas. The scene now releases its context, ignores stale loads, follows the size of its container and rebuilds if the browser drops its context.
- Person/object classification uses the VLM's `type` (it guessed from label words, so "woman" matched "man").
- Selection counts (e.g. "Generate 3D (10)" with 8 cards) included deleted or replaced items.

### Removed

- The automatic fallback from the official Hugging Face Spaces to the author's private duplicate Spaces (`iwatsuki/*`); duplicates of your own can be entered in AI Settings instead.
- The commercial API integrations (Stability AI, Remove.bg), Stable Fast 3D (it depended on a private Space) and TripoSR (low accuracy). Models generated with TripoSR in saved projects still load.
- Unused code: utility functions, types, state, handlers, component props, never-wired card actions and debug logging; unused parts of `index.html` (AI Studio import map, `<model-viewer>`). TypeScript now reports unused variables (`npm run typecheck`).

## v1.1.0
- **Enhanced 3D Object Placement**: Implemented anchor-based positioning using image vertical coordinates and object types (ground vs. table-top) for more realistic placement.
- **Automatic Scaling**: Added depth-variance based automatic scaling to estimate object thickness and size more accurately.
- **Project Saving Improvements**: Now saves the generated Depth Map and 3D Scene configuration, allowing instant scene reconstruction upon loading without re-using API quotas.
- **Hugging Face Token Support**: Added support for Hugging Face Tokens to bypass ZeroGPU quotas for "Stable Fast 3D" and "Depth Anything V2".
- **Environment Variables**: Added `.env.local` support for secure API key management.
- **UI Improvements**: Fixed 3D model initial orientation (now faces forward) and added depth scale adjustments.

## v1.2.0
- **Precise 3D Bounding Box**: Implemented accurate 3D bounding box calculation using pinhole camera projection and depth map sampling.
- **Visualization Cleanup**: Removed distracting debug 3D bounding boxes (blue) while retaining the projected 2D footprint (yellow).
- **UI Standardization**: Updated Scene Reconstruction UI to English and optimized default depth scale to 0.3.

## v1.3.0
- **Batch Completion Workflow**: Added "Complete All/Complete (N)" button to Extracted tab for direct image completion without background removal, improving workflow efficiency.
- **Automatic Tab Switching**: All batch action buttons now automatically navigate to their respective result tabs (Completed, 3D Models, 3D Scene) for immediate visual feedback.
- **3D Model Viewer Enhancements**: Fixed camera positioning and orientation issues - models now properly centered, visible, and viewed from the front.
    *   **Auto-framing**: Implemented automatic camera distance adjustment based on model size using `camera-orbit="180deg 75deg auto"`.

## v1.4.0
- **Nano Banana Pro (Gemini)**: Improved background removal using Gemini 1.5 Pro with enhanced prompts for pure transparency, tight cropping, and shadow removal.
- **Robust Error Handling**: Implemented strategies to handle API quota limits (429) and service availability issues (410), ensuring smoother operation.
- **Documentation**: Updated project history and requirements documentation.

## v1.5.0
- **High-Fidelity 3D Generation**: Integrated `stabilityai/stable-fast-3d` via Gradio Client for superior 3D model generation compared to the deprecated API.
- **Precision Object Alignment**: Implemented AKAZE feature matching with SSD fallback to perfectly align processed objects with their original positions in the scene.
- **Visual Stability**: Fixed bounding box visualization mismatches by implementing dynamic aspect-ratio containers, ensuring the UI accurately reflects the underlying data.
- **Data Persistence**: Refined bounding box data is now correctly persisted to the project file, ensuring scene integrity across saves.
- **Infrastructure Fixes**: Resolved `model-viewer` CORS issues by switching to Google CDN.

## v1.6.0
- **3D Scene Accuracy Upgrades**:
    - **Distance Scaling**: "Depth Scale" now correctly adjusts Z-distance instead of object thickness.
    - **Vertical Stability**: Fixed floating/sinking objects when adjusting depth; objects now stay anchored to the floor.
    - **Correct Orientation**: All 3D models now face the camera by default.
    - **Precision Sampling**: Depth is now sampled from the visible original part ("Green Box") rather than the full bounding box for accurate placement.
- **Interactive Filtering**: Only models selected in the "3D Models" tab are displayed in the 3D scene. Deselecting removes them instantly.
- **UI Improvements**: Added "Generating..." indicator for single-model generation and updated the Depth Scale slider range (0.5x - 10.0x).

## v1.7.0
- **Local TripoSR Integration**: Added support for local 3D model generation using TripoSR via Gradio API.
- **Configurable API URL**: Added settings to specify custom URL for the local TripoSR server.
- **UX Improvements**: Fixed issue where loading a project file triggered an unwanted reset confirmation dialog.

## v1.8.0
- **Depth-Only 3D Scene**:
    - **Green Bounding Box Alignment**: Fixed green bounding box alignment in DepthOnlyScene to match SingleModelViewer exactly. Green box now maintains the same relative position to the 3D model.
    - **Point Cloud Toggle**: Added "Show Point Cloud" checkbox to toggle depth-based point cloud visibility.
    - **Fallback tightBox2d Calculation**: Added automatic tightBox2d calculation when generating 3D models if not pre-calculated, ensuring all models have proper bounding box data.
- **Bug Fixes**:
    - Fixed issue where some models (e.g., man in blue blazer) had incorrect green bounding boxes due to missing tightBox2d data.
    - Removed purple bounding box display from DepthOnlyScene as per user request.

## v1.9.0
- **Unified 3D Scene**:
    - **Depth-Based Positioning**: Replaced semantic interpretation-based 3D scene (SceneReconstruction) with depth-based positioning from DepthOnlyScene. All 3D models are now positioned using depth map information for more accurate placement.
    - **White Background & Grid**: Added clean white background and grid helper (mesh plane) to the 3D scene for better visualization.
    - **Point Cloud On by Default**: Point cloud is now displayed by default for immediate visual feedback.
    - **Default Depth Scale**: Changed default depth scale to 0.5x for better initial scene composition.
- **Project Save/Load Fix**:
    - Fixed issue where 3D models were not visible in 3D Scene after loading a project file. Selected items are now properly restored.
- **Code Cleanup**:
    - Removed all debug console.log statements (20+) for cleaner production code.
    - Deleted unused SceneReconstruction.tsx component.

## v1.10.0
- **Pose-Aware Image Completion**:
    - Pass object description field to image completion prompts to maintain original poses.
    - Increased vertical padding to 80%, added 30% horizontal padding.

## v1.11.0
- **Pose Preservation Enhancements**:
    - Fixed issue where seated persons became standing. "POSE IS SACRED" rule strictly preserves poses.
- **Data URL Format Fix**:
    - Fixed Data URL format for proper PNG transparency loading.
- **Progressive Background Removal**:
    - UI updates immediately after each image processing completion.
- **Depth Map Optimization**:
    - Skip regeneration if depth map already exists.
    - Removed per-object depth map generation.
- **Overlap Processing Improvements**:
    - Implemented refineOverlaps function for pixel-by-pixel comparison in overlapping regions.
    - RGB color similarity (threshold 40) based comparison preserves differently colored pixels.
- **White to Transparent Conversion**:
    - Added convertWhiteToTransparent function. Converts white backgrounds from Gemini to transparent.

## v1.12.0
- **3D Scene Editing**:
    - **TransformControls Integration**: Interactively move, rotate, and scale 3D models.
    - **Object Selection**: Click Whole Box (orange bounding box) to select models. Highlighted in yellow when selected.
    - **Edit Mode**: Edit ON prevents deselection on empty space click. Gizmo persists after dragging.
    - **Scene Save (GLB)**: Export edited 3D scene to CAD-compatible glTF/GLB format. Opens in Blender, Autodesk, FreeCAD, Unity, etc.
    - **Scene Load**: Import previously saved GLB files to restore scenes.
    - **Position Reset**: Restore selected model to original position/rotation/scale.
- **UI Improvements**:
    - Reordered checkboxes: 3D Models → Whole Boxes → Model Boxes → Point Cloud → PC Boxes
    - Moved Edit row to bottom with Edit toggle on right.
    - Auto-hide Point Cloud, Model Boxes, PC Boxes when entering Edit mode.

## v1.13.0
- **TRELLIS.2 Integration**:
    - Added TRELLIS.2 as a new 3D model generation provider via Hugging Face Spaces.
    - Supports high-quality 3D model generation with configurable parameters.
    - Requires Hugging Face Token for private Space access.
- **HF Token UI**:
    - Added HF Token input field in 3D settings row (visible when TRELLIS.2 or Stable Fast 3D is selected).
    - Token is also configurable via `VITE_HF_TOKEN` in `.env.local`.

## v1.14.0
- **Brightness Slider**:
    - Added dynamic brightness adjustment slider (0.5x-3.0x) for 3D models in the 3D Scene view.
    - Allows real-time brightness adjustment for TRELLIS.2 and other providers.
- **TRELLIS.2 Model Fixes**:
    - Fixed orientation - TRELLIS.2 models now face the correct direction.
    - Fixed color space handling with proper sRGB texture mapping.
    - Added authenticated file download with HF token.
- **Point Cloud Visibility**:
    - Changed default state to hidden (unchecked by default).
    - Fixed toggle functionality to properly show/hide based on checkbox state.
- **Image Completion Improvements**:
    - Increased vertical canvas extension from 80% to 120% for better full-body generation.

## v1.15.0
- **TRELLIS.2 Preprocessing Fix**:
    - Fixed "box/wall" artifacts by properly handling transparent backgrounds.
    - Added 1024x1024 square resize with foreground-centered cropping.
    - Implemented alpha premultiplication and binary alpha mask to prevent semi-transparent pixels from becoming surfaces.
- **Transparent Background for Completed Images**:
    - Added `convertWhiteToTransparent` to image completion workflow.
    - Gemini-generated white backgrounds are now converted to transparent before saving.
- **Object Detection Improvements**:
    - Enhanced bounding box prompt with explicit coordinate definitions and aspect ratio verification.
    - Improved detection accuracy for small objects (cups, vases, etc.).
    - Added automatic numbering for duplicate labels (e.g., "Coffee Cup (1)", "Coffee Cup (2)").
- **Default Provider Change**:
    - TRELLIS.2 is now the default 3D model generation provider.

## v1.16.0
- **Adaptive Canvas Sizing**:
    - Gemini now analyzes cropped images to estimate how much of the body/object is cut off.
    - Canvas expansion is automatically adjusted based on the estimated cutoff (instead of fixed 120%).
    - Supports varying expansion ratios from 120% to 350% depending on image content.
- **Completion Verification with Retry**:
    - After generating a completion, Gemini verifies if the body is fully visible.
    - If parts are still missing (feet, legs, etc.), automatically retries with larger canvas (up to 2 retries).
    - Each retry increases canvas size by 30% for better coverage.
    - Retries always use the original cropped image to avoid propagating white gaps.
- **3D Scene UI Improvements**:
    - Removed brightness slider (models now use default lighting).
    - Default view now shows only 3D Models (Whole Boxes, Model Boxes, Point Cloud, PC Boxes off by default).
    - 3D Scene now preserves state when switching tabs (no reload on tab switch).
- **Processing Indicator Fixes**:
    - Processing spinners now persist when switching tabs during background removal, completion, or 3D generation.
    - Changed `processingIds` from `useRef` to `useState` for proper UI reactivity.
- **Stable Fast 3D Endpoint**:
    - Changed endpoint from `stabilityai/stable-fast-3d` to `iwatsuki/stable-fast-3d`.

## v1.17.0
- **Stable Fast 3D API Fix**:
    - Added dedicated `/generate` API endpoint to `iwatsuki/stable-fast-3d` Hugging Face Space.
    - New endpoint handles all preprocessing (background removal, foreground resize) internally.
    - Eliminates dependency on internal Gradio state (`run_btn`, `background_state`) that caused API calls to fail.
    - Client now uses `/generate` instead of `/run_button` for reliable 3D model generation.
- **3D Scene Update Fix**:
    - Fixed issue where 3D Scene didn't update when generating new models or changing selections.
    - Added `key` prop with selected model IDs to force component re-render on changes.

## v1.17.1
- **Image Completion Improvements**:
    - Changed aspect ratio from 3:4 to 9:16 for persons to provide more vertical space for sitting figures.
    - Enhanced prompt to ensure ALL body parts are complete (head, arms, hands, legs, feet).
    - Added "CRITICAL - ALL BODY PARTS MUST BE FULLY VISIBLE" constraint.
    - No body part should be cut off at ANY edge (top, bottom, left, right).
    - White margin/space required around entire body on all sides.

## v1.17.2
- **Workflow Improvements**:
    - **Completion-First Approach**: Now completes extracted images directly (preserving original background context), then applies RMBG after completion.
    - Original background context helps generative AI better understand pose and environment.
    - Post-completion RMBG prevents white object misdetection.
    - Added "RMBG BG removal after completion" checkbox (default ON).
- **AKAZE Feature Matching Improvements**:
    - **Transparent Image Matching**: Both completed and extracted images are processed with RMBG before matching.
    - **Size Validation**: Rejects detected boxes that are too small (partial matches).
    - **tightBox2d Fallback**: Uses completed image object bounds directly when AKAZE fails.
    - Removed SSD template matching (ineffective for low-texture objects).
- **Remove.bg API Fix**:
    - Changed from `image_url` to `image_file` parameter to support Blob URLs and Data URLs.
- **Auto-Selection of New Items**:
    - Newly generated items in Completed and 3D Models tabs are automatically selected.

## v1.17.3
- **Processing Time Measurement**:
    - Added `performance.now()` timers to major processing functions (analysis, completion, 3D generation, depth map).
    - Per-object timing for image generation, BG removal, and AKAZE feature matching.
    - Re-processing the same object overwrites the previous time record.
- **Processing Times UI Panel**:
    - Floating panel at bottom-right displays all recorded processing times.
    - CSV download button for exporting all timing data.
    - Clear button to reset all records.
- **Project Save/Load**:
    - Processing times are saved in project JSON and restored on load.
    - Backward compatible with older project files.

## v1.18.0
- **Removed BG Removed Tab**: Removed the standalone "BG Removed" tab and all associated batch background removal functionality.
    - Background removal is now only used internally as part of the image completion workflow.
    - Removed standalone functions: batch BG removal, batch trim, overlap refinement.
    - Removed NanoBanana provider option.
- **Simplified Landing Page**: Reduced from 4 workflow cards to 3 (Detect & Crop → Image Completion → 3D Generation).
- **Code Cleanup**: Removed ~400 lines of dead code related to standalone BG removal state, functions, and UI.

## v1.18.1 (last private version)
- **Dead Code Removal**: Removed 6 unused functions (~428 lines) from `utils.ts` and `geminiService.ts`.
- **ZeroGPU Fallback**: Added automatic fallback from original HF Spaces to dedicated GPU spaces (`iwatsuki/*`) when ZeroGPU quota is exhausted.
    - Supported services: RMBG (background removal), Depth Anything V2 (depth estimation), TRELLIS.2 (3D generation).
    - Auto-detects GPU quota errors and retries transparently.
- **Removed Smart Extract**: Removed the "Smart Extract (Fix overlaps)" feature from object cards (`smartExtractObject`, `handleSmartExtract`, UI button).
