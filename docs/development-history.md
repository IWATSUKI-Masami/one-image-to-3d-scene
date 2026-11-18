# Project Development History: 3D Scene Reconstruction from One Image

This document summarizes the development timeline and user requirements for the 3D Scene Reconstruction from One Image application.

## Phase 1: Core Object Detection & Cropping
1.  **Initial Setup**: Create an application that performs object detection on a single image and crops out each object using bounding boxes.
2.  **Accuracy Improvement**: Improve cropping accuracy. The initial cuts were not precise enough.
    *   *Solution*: Switched to `gemini-3-pro-preview`, refined prompts to request "tight" bounding boxes, and removed padding for flush cuts.
3.  **Object Separation**: Addressed an issue where vases and flowers were being separated.
    *   *Solution*: Adjusted prompts to group related items (physically connected objects) into single bounding boxes.
4.  **Consistency**: Results varied on every run.
    *   *Solution*: Set API temperature to 0 and fixed the seed.

## Phase 2: Background Removal
5.  **Feature Request**: Add a button to remove backgrounds and show results in a separate tab.
6.  **Implementation Attempts**:
    *   *Attempt 1*: Used `@imgly/background-removal` (Client-side). Failed due to CDN/Wasm loading issues in the environment.
    *   *Attempt 2*: Tried Gemini-based segmentation masks (Polygon/SVG). Resulted in "broken" or low-quality images.
    *   *Final Solution*: Integrated **Remove.bg API**. Added API Key input and batch processing logic.
7.  **Refinement**:
    *   **Error Handling**: Handled 400 errors by sending images as Blobs instead of Base64.
    *   **Thin Objects**: Wooden chairs were being erased.
        *   *Fix*: Attempted padding adjustments (later reverted). Implemented logic to send specific `type` hints ('person' vs 'object') to the API.
    *   **Smart Extraction**: Added a Gemini-based "Smart Extract" feature to handle difficult cases (like overlapping objects) where standard background removal failed.

## Phase 3: Classification & Image Completion
8.  **Classification**: Automatically classify detected items as "Person" or "Object" based on labels (e.g., "Woman in yellow sweater").
    *   *UI*: Added a filter to view "All" or "People Only".
9.  **Direct Upload**: Added a feature to upload already cropped images directly for background removal (Batch Mode), bypassing the detection step.
10. **Full Body Generation (Outpainting)**:
    *   Generate missing lower bodies for cropped portraits using `gemini-3-pro-image-preview`.
    *   *Constraint*: Strictly remove furniture (chairs/tables) and background when generating people.
11. **Object Completion**: Extended generation to general objects (repairing cropped edges of vases, etc.).
    *   *UI*: Added a toggle for Target Type (Person/Object).
    *   *Management*: Added a "Completed" tab to manage AI-generated assets, with delete functionality.
12. **Trimming**: Added a feature to automatically trim transparent edges from processed images.

## Phase 4: 3D Model Generation
13. **Stability AI Integration**: Added functionality to convert "Completed" images into 3D models (GLB) using Stability AI's API.
    *   *UI*: Added a 3D preview card using `<model-viewer>`.
    *   *Flow*: Added a standalone "3D Generation" mode to the landing page.

## Phase 5: 3D Scene Reconstruction
14. **Concept**: Reconstruct the 3D scene by placing generated models back into their relative positions based on the original 2D image.
15. **Implementation (Three.js)**:
    *   Moved from CSS positioning to a full **Three.js** canvas environment.
    *   **Unprojection**: Implemented math to convert 2D bounding box coordinates $(u, v)$ into 3D space $(X, Y, Z)$.
16. **Refinements & Physics**:
    *   **Fog**: Adjusted fog distance to prevent far objects from disappearing.
    *   **Coordinates**: Fixed mirrored layouts (Left/Right swap) and inverted depth (Front/Back swap).
    *   **Scaling**: Implemented "Measure & Fit" logic to scale GLB models correctly based on their distance from the camera.
    *   **Grounding**: Fixed objects sinking into the floor by aligning model bottoms to the calculated 3D floor height.
    *   **Relative Positioning**: Implemented logic to handle objects on tables. Calculated vertical position based on the image $Y$ coordinate, then anchored the scene so the "Person" touches the floor ($Y=0$).
    *   **Tilting**: Fixed objects leaning forward by replacing `lookAt()` with explicit Y-axis rotation using `Math.atan2`.
17. **Depth Estimation**:
    *   **Heuristic**: Initial implementation used vertical position ($Y$) to estimate depth.
    *   **Depth Map**: Integrated **Depth Anything V2** via Hugging Face API (`@gradio/client`) to fetch a real depth map for more accurate Z-positioning.
    *   **Hybrid Logic**: Implemented a "Table-Top Correction" that overrides depth map data if an object is visibly higher than the person's feet in the 2D image, ensuring vases don't sink to the floor.

## Phase 6: Infrastructure & UX
18. **Rebranding**: Renamed application to **"SceneCraft AI"**.
19. **Project Archiving**: Added **Save/Load Project** functionality to persist the entire workflow (images, models, metadata) to a JSON file, saving API credits.
    *   *Detail*: Filenames include phase indicators (e.g., `phase1-2-4`).
20. **Bug Fixes**:
    *   Fixed a "Black Screen" issue in the 3D scene caused by conflicting Three.js versions in the import map.
    *   Fixed CORS issues with Canvas data manipulation.

## Phase 7: Refinement and Optimization (v1.1.0)
21. **Advanced 3D Object Placement**:
    *   **Anchor-Based Positioning**: Implemented placement logic combining vertical image position with object type (ground vs. table-top).
    *   **AI Completion Awareness**: Adjusted positioning anchors to account for 3D models being extended beyond their original bounding boxes (e.g., generated lower bodies).
    *   **Table-Top Objects**: Standardized height for objects detected as "table-top" to prevent floating or sinking.
22. **Automatic Scaling**:
    *   **Depth Variance Analysis**: Calculated depth map variance and range to estimate object 3D thickness.
    *   **Dynamic Correction**: Combined base scale per object type with depth variance to achieve more natural sizing (fixing issues with small objects appearing too tiny).
23. **Complete Project Saving**:
    *   **Depth Map & Scene Persistence**: Now saves the generated Depth Map and 3D Scene state in the project file, eliminating the need for regeneration (and API usage) upon loading.
24. **API Quota Management & Security**:
    *   **Hugging Face Token Support**: Added token input to bypass ZeroGPU quotas for "Stable Fast 3D" and "Depth Anything V2".
    *   **Environment Variables**: Added `.env.local` support for secure API key management.
25. **UX Improvements**:
    *   **3D Model Orientation**: Corrected initial camera orbit to face models from the front.
    *   **Depth Adjustment**: Added a slider to adjust the overall depth perception of the scene.

## Phase 8: 3D Bounding Box & Visualization Refinement (v1.2.0)
26. **3D Bounding Box Calculation**:
    *   **Pinhole Camera Model**: Implemented strict 3D bounding box calculation using the pinhole camera model.
    *   **Depth Sampling**: Samples depth from non-transparent pixels of background-removed images using median for accurate 3D positioning.
    *   **Unprojection**: Converts 2D image coordinates and depth values into accurate 3D world coordinates.
27. **Visualization Cleanup**:
    *   **Removed Blue Bounding Boxes**: Removed the debug visualization of the calculated 3D bounding boxes (cyan/blue boxes) to clean up the view.
    *   **Retained Projected Boxes**: Kept the yellow "Projected 2D Bounding Box" visualization to show the original image footprint in 3D space.
28. **UI & UX Updates**:
    *   **English UI**: Standardized all UI text in the Scene Reconstruction component to English.
    *   **Default Depth Scale**: Updated the default depth scale to `0.3` for a more natural initial scene composition.

## Phase 9: Workflow Optimization & Model Viewer Enhancement (v1.3.0)
29. **Batch Completion from Extracted Images**:
    *   **Direct Completion**: Added ability to batch complete images directly from the "Extracted" tab, skipping the background removal step entirely.
    *   **API Efficiency**: Reduces API calls by allowing users to go straight from cropped images to AI-completed images when background removal isn't needed.
    *   **UI Addition**: Added "Complete All" / "Complete (N)" button to the "Extracted" tab action bar.
30. **Automatic Tab Navigation**:
    *   **Immediate Feedback**: All batch action buttons now automatically switch to the relevant tab when clicked:
        - "Complete" button → switches to "Completed" tab
        - "Generate 3D" button → switches to "3D Models" tab
        *   *Tight Crop*: Requested "TIGHT CROP" to solve issues where the output object was too small relative to the canvas.
        *   *No Shadows*: Explicitly requested removal of all shadows to ensure a clean sprite.
33. **Error Handling & Resilience**:
    *   **Quota Management**: Addressed `429 Too Many Requests` from Gemini by implementing rate limiting and fallbacks.
    *   **Service Availability**: Addressed `410 Gone` errors from Hugging Face models by updating proxy targets and implementing fallback strategies.
    *   **Fallback Strategy**: Designed a multi-tiered approach (Gemini -> Local/Hugging Face -> Remove.bg) to ensure functionality even when primary services fail.

## Phase 11: High-Fidelity 3D Generation & Precision Alignment (v1.5.0)
34. **Integration of Stable Fast 3D (Gradio)**:
    *   **Migration**: Replaced the deprecated Stability AI API with `stabilityai/stable-fast-3d` via Hugging Face Gradio Client.
    *   **Quality**: Achieved significantly higher fidelity 3D models (GLB) directly from the application.
35. **Precision Object Alignment (AKAZE)**:
    *   **Feature Matching**: Implemented **AKAZE** (Accelerated-KAZE) feature matching using OpenCV.js to find the exact position of processed objects within the original scene.
    *   **Fallback Mechanism**: Added an **SSD** (Sum of Squared Differences) fallback for cases where feature matching yields insufficient matches.
    *   **Result**: "Processed" objects (background removed/completed) now snap perfectly to their original positions, ensuring 3D spatial coherence.
36. **Infrastructure & UX Polish**:
    *   **Visual Fixes**: Solved a long-standing issue where bounding box overlays were misaligned due to container aspect ratio mismatches. Implemented a dynamic container system in `ResultCard`.
    *   **CORS Resolution**: Switched `model-viewer` CDN to Google's official endpoint to resolve persistent CORS and 500 errors.

## Phase 12: 3D Scene Refinement & UX Polish (v1.6.0)
37. **3D Scene Accuracy Upgrades**:
    *   **Distance Scaling**: Replaced object thickness scaling with "Distance Scaling". The `depthScale` slider now adjusts the Z-position (distance) of objects to enhance depth perception without distorting object shapes.
    *   **Vertical Stability**: Fixed an issue where adjusting depth caused objects to float or sink. Objects now remain anchored to the floor plane ($Y=0$) regardless of depth scaling.
    *   **Correct Orientation**: Fixed GLB model loading to ensure all models face the camera by default (180-degree rotation).
    *   **Precision Sampling**: Updated depth sampling to use only non-transparent pixels (alpha > 128) from background-removed images. Takes median of all visible pixels for robust depth estimation, with fallback to center/bottom-center sampling.
38. **Interactive Scene Filtering**:
    *   **Selection Sync**: Implemented a filtering system where only models selected (checked) in the "3D Models" tab are displayed in the 3D scene.
    *   **Real-time Updates**: Deselecting a model instantly removes it from the scene, allowing for easier composition and clutter removal.
    *   **Empty State Fix**: Resolved a bug where the 3D scene would appear empty when switching tabs by ensuring proper default selection logic.
39. **UI/UX Enhancements**:
    *   **Loading Feedback**: Added a clear "Generating..." indicator in the "3D Models" tab for single-model generation, preventing user confusion during processing.
    *   **Slider Configuration**: Updated the Depth Scale slider range to `0.5x - 10.0x` (default `1.0x`) for more versatile scene layout control.

## Phase 13: Local TripoSR Integration (v1.7.0)
40. **Local TripoSR Support**:
    *   Added "TripoSR (Local)" option for 3D generation using a local Gradio server.
    *   Configurable API URL for local TripoSR server (default: `http://127.0.0.1:7860/`).
41. **UX Fixes**:
    *   Fixed "Start Over" confirmation loop when loading project files.

## Phase 14: DepthOnlyScene Improvements (v1.8.0)
42. **Green Bounding Box Alignment**:
    *   **Exact SingleModelViewer Replication**: Rewrote green bounding box calculation in `DepthOnlyScene` to exactly match `SingleModelViewer` logic. Green box now maintains relative position to 3D model.
    *   **Container-Based Approach**: Implemented a `THREE.Group` container system to keep mesh and green box aligned during scaling and positioning.
43. **Fallback tightBox2d Calculation**:
    *   **Automatic Calculation**: Added fallback logic in `handleGenerate3D` to calculate `tightBox2d` on-the-fly if not pre-calculated by `ResultCard`.
    *   **Data Integrity**: Ensures all 3D models have proper bounding box metadata for accurate green box rendering.
44. **UI Improvements**:
    *   **Point Cloud Toggle**: Added "Show Point Cloud" checkbox to toggle depth-based point cloud visibility in `DepthOnlyScene`.
    *   **Purple Box Removal**: Removed purple (model-wide) bounding box from `DepthOnlyScene` as per user request, keeping only green box for `originalPartBox2d`.

## Phase 15: Unified 3D Scene & Code Cleanup (v1.9.0)
45. **Unified 3D Scene Architecture**:
    *   **Replaced SceneReconstruction**: Removed semantic interpretation-based `SceneReconstruction.tsx` component entirely.
    *   **Depth-Based Positioning Only**: All 3D model positioning now uses depth map information from `DepthOnlyScene` for more accurate and consistent placement.
    *   **Single 3D Scene Tab**: Merged "Depth Scene" and old "3D Scene" into a unified "3D Scene" tab.
46. **Visual Improvements**:
    *   **White Background**: Changed scene background from dark slate to clean white for better model visibility.
    *   **Grid Helper**: Added `THREE.GridHelper` as a mesh plane floor for spatial reference.
    *   **Default Point Cloud**: Point cloud is now displayed by default (`showPointCloud: true`).
    *   **Optimized Depth Scale**: Default depth scale set to 0.5x for better initial composition.
47. **Project Save/Load Fix**:
    *   **Selected Items Restoration**: Fixed issue where 3D models were invisible in 3D Scene after loading a project. `selectedItems` state is now properly restored from loaded models.
48. **Code Cleanup**:
    *   **Removed Debug Logs**: Removed 20+ `console.log` statements from `App.tsx`, `DepthOnlyScene.tsx`, and `utils.ts`.
    *   **Deleted Unused Component**: Removed `SceneReconstruction.tsx` (no longer used after unification).

## Phase 16: Pose-Aware Image Completion (v1.10.0)
49. **Pose Information Propagation**:
    *   **Description Field Utilization**: The `description` field from object detection (containing pose, posture, action, and clothing details) is now passed to the image completion prompt.
    *   **Pose Preservation Enhancement**: Added "IMPORTANT - Original pose description" section to the prompt, explicitly instructing the model to maintain the original pose (e.g., sitting, leaning forward).
50. **Image Padding Improvements**:
    *   **Vertical Padding**: Increased from 60% to 80% to accommodate legs for seated poses.
    *   **Horizontal Padding**: Added 30% horizontal padding (15% on each side) to allow completion of cut-off hands and arms.
    *   **Centered Positioning**: Original image is now centered horizontally within the padded canvas.
51. **Completion Prompt Revision**:
    *   **Priority Ordering**: Introduced "CRITICAL PRIORITY ORDER" to clearly prioritize instructions.
    *   **Full Body Part Completion**: Added explicit instructions to complete all cut-off body parts (hands, arms, legs, feet).
    *   **Canvas Extension**: Instructed the model to extend the canvas in all directions rather than shrinking the person.

## Phase 17: Pose Strictness & Performance Optimization (v1.11.0)
52. **Pose Preservation Enforcement**:
    *   **"POSE IS SACRED" Rule**: Fixed issue where sitting people were generated standing. Major prompt revision to strictly preserve sitting/leaning/crouching poses.
    *   **Pose Consistency**: Explicitly instructed to maintain posture after furniture removal ("REMOVE FURNITURE BUT KEEP POSE").
53. **Data URL Format Fix**:
    *   **Transparency Restoration**: Fixed malformed Data URL format in `geminiService.ts` (`data: image / png;` → `data:image/png;`), restoring proper PNG alpha channel loading.
54. **Progressive Background Removal Display**:
    *   **Incremental Updates**: Modified `handleRemoveBackgrounds` to update UI immediately after each image is processed (instead of waiting for all to complete).
55. **Depth Map Optimization**:
    *   **Duplicate Generation Prevention**: Added existence check to `handleGenerateDepthMap` to skip regeneration if depth map already exists.
    *   **Per-Object Generation Removal**: Removed individual object depth map generation from `handleGenerate3D` (scene-level depth map is sufficient).
56. **Overlap Processing Improvements**:
    *   **refineOverlaps Implementation**: Direct pixel comparison using bounding box coordinate transformation to detect and remove overlap regions.
    *   **loadImageForMask Helper**: Added helper function to correctly handle CORS settings for Data URLs.
    *   **Pixel Color Matching**: Overlap pixels are determined based on RGB color similarity (threshold: 40). Pixels with different colors are preserved.
57. **White-to-Transparent Conversion**:
    *   **convertWhiteToTransparent Function**: Added post-processing to convert white backgrounds returned by Gemini to transparent.
    *   **Automatic Application**: Automatically applied after Nano Banana background removal (threshold: 240).

## Phase 18: 3D Scene Editing (v1.12.0)
58. **TransformControls Integration**:
    *   **Interactive Manipulation**: Integrated TransformControls for moving, rotating, and scaling 3D models.
    *   **Object Selection**: Click Whole Box (orange bounding box) to select models. Highlighted in yellow when selected.
    *   **Mode Switching**: Move/Rotate/Scale buttons to switch transform modes.
59. **Edit Mode**:
    *   **Selection Persistence**: Edit ON prevents deselection on empty space click, enabling continuous manipulation.
    *   **Drag State Tracking**: `isDraggingRef` with 200ms timeout ignores click events after dragging, preventing gizmo disappearance.
    *   **Auto-Hide Layers**: Point Cloud, Model Boxes, and PC Boxes automatically hidden when entering Edit mode.
60. **Scene Save/Load (GLB)**:
    *   **GLTFExporter Integration**: Export scene to GLB format using `three/addons/exporters/GLTFExporter.js`.
    *   **CAD Compatibility**: Output files can be opened in Blender, Autodesk, FreeCAD, Unity, Unreal Engine, etc.
    *   **Scene Import**: Load GLB files via file picker to restore scenes.
61. **Position Reset**:
    *   **originalTransformsRef**: Implemented Map to store each model's position/rotation/scale on first selection.
    *   **Reset Button**: Restore selected model to original state.
62. **UI Improvements**:
    *   **Checkbox Reordering**: Changed order to 3D Models → Whole Boxes → Model Boxes → Point Cloud → PC Boxes.
    *   **Edit Row Layout**: Moved Edit row to bottom with Edit toggle on the right.

## Phase 19: TRELLIS.2 Integration (v1.13.0)
63. **TRELLIS.2 3D Generation**:
    *   **Gradio Client Integration**: Added `generate3DModelWithTrellis` function using `@gradio/client` to connect to `iwatsuki/TRELLIS.2` Hugging Face Space.
    *   **API Workflow**: Implements 3-step workflow: `/start_session` → `/image_to_3d` → `/extract_glb` for GLB model extraction.
    *   **Provider Selection**: Added "TRELLIS.2" button to 3D provider selector in header with emerald color scheme.
64. **HF Token Management**:
    *   **UI Input Field**: Added HF Token input field (visible when TRELLIS.2 or Stable Fast 3D is selected).
    *   **Environment Variable**: Token also configurable via `VITE_HF_TOKEN` in `.env.local`.
    *   **Private Space Support**: Token is required for accessing private Hugging Face Spaces like `iwatsuki/TRELLIS.2`.

## Phase 20: TRELLIS.2 & Display Improvements (v1.14.0)
65. **Brightness Slider**:
    *   **Dynamic Control**: Added brightness adjustment slider (0.5x-3.0x) in 3D Scene controls.
    *   **Real-Time Update**: `useEffect` traverses modelsGroup and updates material.color on slider change.
    *   **Universal Application**: Brightness applied to all 3D models regardless of provider.
66. **TRELLIS.2 Model Fixes**:
    *   **Orientation**: TRELLIS.2 models skip 180° rotation (they face correct direction by default).
    *   **Provider Field**: Added `provider` field to `Model3D` type to track generation source.
    *   **Color Space**: Apply `THREE.SRGBColorSpace` to texture maps and emissive maps for proper color rendering.
    *   **Material Array Handling**: Fixed colorSpace fix to handle both single material and material arrays.
    *   **Authenticated Download**: Added Authorization header with HF token for GLB file fetch.
67. **Point Cloud Visibility**:
    *   **Default Off**: Changed initial `showPointCloud` state and ref from `true` to `false`.
    *   **Toggle Fix**: Ensured toggle correctly shows/hides based on checkbox state.
68. **Image Completion Canvas Extension**:
    *   **Increased Padding**: Vertical padding ratio increased from 0.8 (80%) to 1.2 (120%) for better full-body generation.

## Phase 21: TRELLIS.2 Preprocessing & Detection Fixes (v1.15.0)
69. **TRELLIS.2 Preprocessing Fix**:
    *   **Root Cause**: Completed Images had opaque white backgrounds (Gemini generates white, not transparent).
    *   **Transparent Conversion**: Added `convertWhiteToTransparent` call after `generateCompletion` in both `handleCompleteBody` and `handleBatchCompleteExtracted`.
    *   **1024x1024 Square Resize**: Restored foreground-centered square crop and resize to 1024x1024.
    *   **Alpha Premultiply**: Apply RGB * Alpha to match TRELLIS.2 expected input format.
    *   **Binary Alpha Mask**: Pixels with alpha < 128 become fully transparent (0), others become fully opaque (255) to prevent semi-transparent artifacts.
70. **Object Detection Improvements**:
    *   **Explicit Bounding Box Definition**: Added coordinate definitions (ymin = top edge, ymax = bottom edge, xmin = left edge, xmax = right edge).
    *   **Aspect Ratio Verification**: Added instruction "VERIFY: The aspect ratio of the box MUST match the object's actual shape."
    *   **Debug Logging**: Added console logging for Gemini detection response to aid troubleshooting.
    *   **Duplicate Label Numbering**: Added automatic numbering for duplicate labels in `cropObjectsFromImage` (e.g., "Coffee Cup (1)", "Coffee Cup (2)").
71. **Default Provider Change**:
    *   **TRELLIS.2 Default**: Changed `modelProvider` initial state from `'huggingface'` to `'trellis'`.

## Phase 22: Adaptive Canvas & Completion Verification (v1.16.0)
72. **Adaptive Canvas Sizing**:
    *   **`estimateCanvasExpansion`**: New Gemini function that analyzes cropped images to estimate body/object cutoff percentages.
    *   **Dynamic Expansion**: Canvas expansion automatically adjusted based on estimated cutoff (bottomCutoffPercent, topCutoffPercent, sideCutoffPercent).
    *   **Clamped Ratios**: Vertical ratio clamped between 1.2 (120%) and 3.5 (350%); horizontal between 1.1 (110%) and 2.0 (200%).
    *   **Updated `prepareImageForCompletion`**: Now accepts optional `customVerticalRatio` and `customHorizontalRatio` parameters.
73. **Completion Verification with Retry**:
    *   **`verifyCompletion`**: New Gemini function that checks if generated completion shows full body (head, torso, arms, legs, feet).
    *   **Retry Logic**: If verification fails, retry with 30% larger canvas (up to 2 retries = 3 total attempts).
    *   **Progressive Expansion**: Each retry increases canvas by 30% vertical and 15% horizontal.
    *   **Original Image Reuse**: Retries always use the ORIGINAL cropped image (not the incomplete generated image) to avoid propagating white gaps.
    *   **Best Effort**: After max retries, uses best available result even if still incomplete.
74. **3D Scene UI Improvements**:
    *   **Removed Brightness Slider**: Deleted `modelBrightness` state, useEffect, and slider UI from `DepthOnlyScene.tsx`.
    *   **Default 3D Models Only**: Changed initial states to `showModelBoxes=false`, `showWholeModelBoxes=false`, `showBoxes=false` (only 3D Models visible by default).
    *   **Tab State Persistence**: Changed 3D Scene from conditional rendering (`{activeTab === 'scene' && ...}`) to CSS `display: none/block` to prevent remount on tab switch.
75. **Processing Indicator Fixes**:
    *   **Ref to State**: Changed `processingIds` from `useRef<Set<string>>` to `useState<Set<string>>` for proper UI reactivity.
    *   **Persistent Spinners**: Added `isProcessing` prop to `ResultCard` component, passed from parent's `processingIds` state.
    *   **Full Coverage**: Added `processingIds` tracking to `handleCompleteBody`, `handleRemoveBackgroundSingle`, and ensured `handleGenerate3D` uses it.
76. **Stable Fast 3D Endpoint Change**:
    *   **Custom Space**: Changed Stable Fast 3D endpoint from `stabilityai/stable-fast-3d` to `iwatsuki/stable-fast-3d`.

## Phase 23: Stable Fast 3D API Endpoint Fix (v1.17.0)
77. **Clean API Endpoint**:
    *   **`/generate` Endpoint**: Added dedicated `api_generate` function to `gradio_app.py` in `iwatsuki/stable-fast-3d` Hugging Face Space.
    *   **Internal Preprocessing**: New endpoint handles all preprocessing internally (background removal via rembg, foreground resize).
    *   **State Independence**: Eliminates dependency on internal Gradio state (`run_btn`, `background_state`) that caused API calls to fail with "An error occurred".
78. **Client-Side Updates**:
    *   **Endpoint Migration**: Changed `client.predict()` from `/run_button` to `/generate`.
    *   **Simplified Response**: New endpoint returns single GLB file output (previously was tuple of 6 elements).
    *   **Result Parsing**: Updated result parsing from `data[1]` to `data[0]` to match new single-output format.
79. **3D Scene Update Fix**:
    *   **Key Prop Addition**: Added `key` prop to `DepthOnlyScene` component using selected model IDs.
    *   **Forced Re-render**: Component now correctly re-renders when new models are generated or selection changes.
    *   **Conditional Rendering**: Reverted from `visibility:hidden` to conditional rendering to avoid layout issues with Three.js canvas.
80. **Image Completion Improvements**:
    *   **Aspect Ratio**: Changed from 3:4 to 9:16 for persons to provide more vertical space for sitting figures.
    *   **Enhanced Prompt**: Added "CRITICAL - ALL BODY PARTS MUST BE FULLY VISIBLE" section.
    *   **All Body Parts**: Arms, hands, legs, feet must all be complete - no cutoffs at any edge.
    *   **Margin**: White space required around entire body on all sides (top, bottom, left, right).

## Phase 24: Workflow Improvements & AKAZE Algorithm Optimization (v1.17.2)
81. **Workflow Changes**:
    *   **Completion-First Approach**: Changed to complete extracted images directly (preserving original background context), then apply RMBG after completion.
    *   **Background Context Utilization**: Retaining original background helps generative AI better understand pose and environment.
    *   **White Object Protection**: Post-completion RMBG processing prevents false detection of white objects (cups, vases, etc.).
    *   **UI Option**: Added "RMBG BG removal after completion" checkbox (default ON).
82. **AKAZE Matching Improvements**:
    *   **Transparent Image Matching**: Both completed and extracted images are processed with RMBG before matching. Feature points are detected only in object regions.
    *   **Size Validation**: Rejects detected boxes that are too small (less than 30% of image) as partial matches.
    *   **tightBox2d Fallback**: When AKAZE fails, uses the completed image's object bounds (tightBox2d) directly.
    *   **SSD Removal**: Removed SSD template matching (ineffective for low-texture objects).
83. **Bounding Box Alignment Fix**:
    *   **tightBox2d Saving**: When using tightBox2d fallback, now saves both `originalPartBox2d` and `tightBox2d` fields.
    *   **3D Viewer Consistency**: Green box (Original Part) and purple box (Full Object) now align correctly.
84. **Remove.bg API Fix**:
    *   **Parameter Change**: Changed from `image_url` to `image_file` parameter to support Blob URLs and Data URLs.
85. **Auto-Selection of New Items**:
    *   **`addToSelection` Helper**: Added helper function to automatically select newly generated items in corresponding tabs.
    *   **Scope**: Applied to Completed and 3D Models tabs.

## Phase 25: Processing Time Measurement (v1.17.3)
86. **Processing Time Tracking**:
    *   **`performance.now()`**: Added timers to 8 major processing functions.
    *   **Target Functions**: `startAnalysis`, `handleCompleteBody`, `handleBatchCompleteExtracted`, `handleGenerate3D`, `handleBatchGenerate3D`, `handleGenerateDepthMap`.
    *   **Per-Object Measurement**: Image completion generation, BG removal, and AKAZE feature matching measured individually per object.
    *   **Console Logging**: Output in `[Timer] Operation: XX.Xs` format.
    *   **Overwrite on Re-process**: Re-processing the same object overwrites the previous time.
87. **Processing Times UI Panel**:
    *   **Floating Panel**: Displays processing time list at bottom-right of screen.
    *   **CSV Download**: All processing times downloadable as CSV file.
    *   **Clear Button**: Bulk delete all recorded processing times.
88. **Project Save/Load Support**:
    *   **`ProjectArchive` Type Extension**: Added `processingTimes` field (`Record<string, number>`).
    *   **Map⇔Object Conversion**: Saves Map as object via `Object.fromEntries()`, restores via `Object.entries()`.
    *   **Backward Compatibility**: Optional field ensures older project files load correctly.

## Phase 26: BG Removed Tab Removal & UI Simplification (v1.18.0)
89. **BG Removed Tab Removal**:
    *   **Standalone BG Removal Removed**: Removed the "BG Removed" tab and all associated standalone background removal functionality.
    *   **Functions Removed**: `handleRemoveBackgrounds`, `handleRemoveBackgroundSingle`, `handleBatchTrim`, `handleRefineOverlaps`, `handleRefineSingleOverlap`, `handleDeleteProcessedImage`, `handleBatchCompleteBody`.
    *   **State Removed**: `processedImages`, `isProcessingBg`, `bgError`, `isRefining`, `filteredProcessedImages`.
    *   **Internal BG Removal Preserved**: Background removal used internally by the completion workflow (`performCompletion`, `handleCompleteBody`, `handleBatchCompleteExtracted`) remains intact.
90. **NanoBanana Provider Removal**:
    *   **Removed**: `nano-banana` option from the BG removal provider selector.
    *   **Default Changed**: Default BG removal provider changed from `nano-banana` to `rembg`.
    *   **Import Cleanup**: Removed unused `removeBackgroundWithNanoBanana` import.
91. **Landing Page Simplification**:
    *   **3-Card Layout**: Reduced from 4 workflow cards to 3 (Detect & Crop → Image Completion → 3D Generation).
    *   **Removed**: "Batch BG Remover" card and its `handleBatchUploadSelected` upload handler.
92. **Type Updates**:
    *   **`ProjectArchive`**: `processedImages` field changed from required to optional for backward compatibility.
    *   **`activeTab`**: Removed `'transparent'` from the union type.
    *   **`selectedItemsPerTab`**: Removed `transparent` key.

## Phase 27: Code Cleanup & ZeroGPU Fallback (v1.18.1)
93. **Dead Code Removal**:
    *   **Functions Removed (6 total, ~428 lines)**:
        *   `removeBackgroundWithNanoBanana` (`geminiService.ts`)
        *   `convertWhiteToTransparent`, `fitImageToSize`, `performMatching`, `findBestMatchPositionSSD`, `calculate3DBoundingBox` (`utils.ts`)
    *   **Unused Import Cleanup**: Removed `ProcessResult`, `Box3D`, `convertWhiteToTransparent` imports.
94. **ZeroGPU Fallback Mechanism**:
    *   **Fallback Configuration**: Automatic switchover to dedicated GPU spaces when ZeroGPU quota is exhausted.
    *   **Target Services**:
        *   Background Removal: `briaai/BRIA-RMBG-2.0` → `iwatsuki/BRIA-RMBG-2.0`
        *   Depth Estimation: `depth-anything/Depth-Anything-V2` → `iwatsuki/Depth-Anything-V2`
        *   3D Model Generation: `microsoft/TRELLIS.2` → `iwatsuki/TRELLIS.2`
    *   **Error Detection**: `isZeroGPUQuotaError` helper auto-detects GPU quota, rate limit, and related error patterns.
    *   **Logging**: Console logs fallback events in `[RMBG] ZeroGPU quota exceeded...falling back to iwatsuki/...` format.
95. **Paper (`paper.tex`) Improvements**:
    *   Translated pipeline step titles to Japanese (with English in parentheses).
    *   Converted all noun-ending sentences to verb-ending sentences.
    *   Added introductory phrases before equations.
    *   Fixed typo "奨行き" → "奥行き".
96. **Smart Extract Feature Removal**:
    *   **Functions Removed**: `smartExtractObject` (`geminiService.ts`), `handleSmartExtract` (`App.tsx`).
    *   **UI Removed**: Smart Extract (Fix overlaps) button, handler, and loading state from `ResultCard.tsx`.
