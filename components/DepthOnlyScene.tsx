import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { removeStrayFragments } from './meshCleanup';
import { alignmentYawDeg, ASSUMED_HFOV_DEG, MIN_ALIGNMENT_SCORE, viewAngleDeg } from '../services/frontAlignment';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Spinner } from './Spinner';
import { DetectedObject, Model3D, SceneLayout } from '../types';
import { ArrangeObject, ArrangeScene, ArrangeView, PlacementEdit, arrangeSceneWithClaude } from '../services/semanticArrange';
import { Box2D, DepthRange, ObjectMask, depthFromBrightness, loadObjectMask, medianDepthInBox, sameBox } from './depthSampling';

const boxKey = (box: Box2D): string => box.map(v => v.toFixed(6)).join(',');

/**
 * Alpha masks for Eq. (4).
 * - Photo masks (SAM 2.1, `DetectedObject.mask`) cover the whole photo, so the
 *   object's box is also its region in the mask. They show exactly the visible
 *   pixels and are preferred.
 * - Otherwise the background-removed image of each model is used. A completed
 *   image is larger than the original crop; `originalPartBox2d` (found by AKAZE)
 *   tells which part of it matches the object's box in the scene. Without that
 *   alignment the mask cannot be placed, so none is used.
 */
const loadSceneMasks = async (models: Model3D[], objects: DetectedObject[]) => {
    const byBox = new Map<string, ObjectMask>();
    await Promise.all(objects.map(async (obj) => {
        if (!obj.mask) return;
        try {
            byBox.set(boxKey(obj.box_2d), await loadObjectMask(obj.mask.url, obj.box_2d));
        } catch (e) {
            console.warn(`Failed to load the photo mask of ${obj.label}`, e);
        }
    }));
    const byModel = new Map<string, ObjectMask>();
    await Promise.all(models.map(async (model) => {
        const photoMask = model.box_2d ? byBox.get(boxKey(model.box_2d)) : undefined;
        if (photoMask) {
            byModel.set(model.id, photoMask);
            return;
        }
        const region: Box2D | null = model.originalPartBox2d
            ?? (model.completionExpansionRatio === undefined ? [0, 0, 1, 1] : null);
        if (!region || !model.posterUrl) return;
        try {
            byModel.set(model.id, await loadObjectMask(model.posterUrl, region));
        } catch (e) {
            console.warn(`Failed to load mask for ${model.label}; using all pixels in the box`, e);
        }
    }));
    return { byModel, byBox };
};

/** Position, rotation (Euler XYZ, radians) and scale of a model's container in the scene */
interface SavedTransform {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
}

/** Scene layout file: where each model is, without the models themselves (they are in the project) */
interface SceneLayoutFile extends SceneLayout {
    format: 'one-image-to-3d-scene/layout';
    version: 1;
    savedAt: string;
    scene?: string;
}

const LAYOUT_FORMAT = 'one-image-to-3d-scene/layout';

const transformOf = (obj: THREE.Object3D): SavedTransform => ({
    position: obj.position.toArray() as [number, number, number],
    rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
    scale: obj.scale.toArray() as [number, number, number],
});

const applyTransform = (obj: THREE.Object3D, t: SavedTransform) => {
    obj.position.fromArray(t.position);
    obj.rotation.set(t.rotation[0], t.rotation[1], t.rotation[2]);
    obj.scale.fromArray(t.scale);
};

/** One step of the edit history: the placement of a model before and after it (undefined = automatic) */
interface EditStep {
    modelId: string;
    before?: SavedTransform;
    after?: SavedTransform;
}

const sameTransform = (a?: SavedTransform, b?: SavedTransform) =>
    !!a && !!b && [...a.position, ...a.rotation, ...a.scale].every((v, i) => Math.abs(v - [...b.position, ...b.rotation, ...b.scale][i]) < 1e-9);

const isVec3 = (v: unknown): v is [number, number, number] =>
    Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));

interface DepthOnlySceneProps {
    imageUrl: string;
    depthMapUrl: string;
    originalAspectRatio?: number;
    detectedObjects?: DetectedObject[];
    positionedModels?: Model3D[];
    showModels?: boolean;
    /** Used in the names of saved files (e.g. the photo's name) */
    sceneName?: string;
    /** Placements set by hand, settings and camera to start from (e.g. from a loaded project) */
    initialLayout?: SceneLayout;
    /** Called when placements set by hand, the settings or the camera change, so the project can save them */
    onLayoutChange?: (layout: SceneLayout) => void;
    /** Anthropic API key and Claude model for Arrange (semantic arrangement of the models) */
    claudeApiKey?: string;
    claudeModel?: string;
    /** Opens the AI Settings dialog (when the Anthropic API key is missing) */
    onOpenSettings?: () => void;
}

export const DepthOnlyScene: React.FC<DepthOnlySceneProps> = ({
    imageUrl,
    depthMapUrl,
    originalAspectRatio = 1,
    detectedObjects = [],
    positionedModels = [],
    showModels = true,
    sceneName,
    initialLayout,
    onLayoutChange,
    claudeApiKey,
    claudeModel,
    onOpenSettings,
}) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = useState(true);
    const [depthScale, setDepthScale] = useState(initialLayout?.settings.depthScale ?? 0.5);
    // Bumped to rebuild the scene after the browser drops its WebGL context
    const [contextGeneration, setContextGeneration] = useState(0);
    const [pointSize, setPointSize] = useState(initialLayout?.settings.pointSize ?? 2.0);
    const [showBoxes, setShowBoxes] = useState(false); // PC Boxes off by default
    const [showPointCloud, setShowPointCloud] = useState(false);
    const [showModelsToggle, setShowModelsToggle] = useState(showModels);
    const [showModelBoxes, setShowModelBoxes] = useState(false); // Model Boxes off by default
    // Turn models so that their front view matches their completed image
    const [applyAlignment, setApplyAlignment] = useState(initialLayout?.settings.applyAlignment ?? true);
    // Perspective back-projection (see toWorldXY); off = the paper's image-plane placement
    const [perspective, setPerspective] = useState(initialLayout?.settings.perspective ?? true);
    // Info panel at the bottom left (can be hidden so that it does not cover the scene)
    const [showInfo, setShowInfo] = useState(true);
    const [showWholeModelBoxes, setShowWholeModelBoxes] = useState(false); // Whole Boxes off by default
    const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
    // Arrange (Claude): render function set by the scene setup, progress log, cancel
    const arrangeRenderRef = useRef<((view: ArrangeView, labels: { text: string; center: THREE.Vector3 }[]) => string) | null>(null);
    const floorYRef = useRef(-1);
    const gridRef = useRef<THREE.GridHelper | null>(null);
    const [arranging, setArranging] = useState(false);
    const [arrangeLog, setArrangeLog] = useState<string[]>([]);
    const arrangeAbortRef = useRef<AbortController | null>(null);
    // Edit history (Undo / Redo) of placements set by hand
    // Each history entry is a group of model changes undone together (one drag, or one Arrange run)
    const undoStackRef = useRef<EditStep[][]>([]);
    const redoStackRef = useRef<EditStep[][]>([]);
    const [historySize, setHistorySize] = useState({ undo: 0, redo: 0 });
    const updateHistorySize = () => setHistorySize({ undo: undoStackRef.current.length, redo: redoStackRef.current.length });
    // Placement of the model being dragged, when the drag started (undefined = automatic)
    const dragStartRef = useRef<{ modelId: string; before?: SavedTransform } | null>(null);
    // Scale: one handle scales all axes by the same factor (keeps the model's proportions)
    const [uniformScale, setUniformScale] = useState(true);
    const uniformScaleRef = useRef(true);
    uniformScaleRef.current = uniformScale;
    const [selectedModelIndex, setSelectedModelIndex] = useState<number>(-1);
    const [editMode, setEditMode] = useState(false); // When true, clicking empty space won't deselect

    // Refs to track current visibility state for use in closures
    const showPointCloudRef = useRef(false);
    const showModelsRef = useRef(showModels);
    const showModelBoxesRef = useRef(false); // Match default state
    const showWholeModelBoxesRef = useRef(false); // Match default state
    const showBoxesRef = useRef(false); // Match default state
    const loadVersionRef = useRef(0); // Track model load version to prevent duplicates
    const meshContainersRef = useRef<THREE.Group[]>([]); // Store mesh containers for transform
    const wholeBoxContainersRef = useRef<THREE.Group[]>([]); // Store whole box containers for highlighting
    const transformControlsRef = useRef<TransformControls | null>(null);
    const isDraggingRef = useRef(false); // Track if currently dragging to prevent click after drag
    const editModeRef = useRef(false); // Track editMode for use in click handler closure
    const raycasterRef = useRef(new THREE.Raycaster());
    const mouseRef = useRef(new THREE.Vector2());
    // Placements set by hand (edit mode) or loaded from a layout file, by model id.
    // They replace the automatic placement and survive scene rebuilds (e.g. a depth change).
    const layoutRef = useRef<Map<string, SavedTransform>>(new Map(
        (initialLayout?.models ?? [])
            .filter(m => isVec3(m.position) && isVec3(m.rotation) && isVec3(m.scale))
            .map(m => [m.id, { position: m.position, rotation: m.rotation, scale: m.scale }])
    ));
    // Camera of a loaded layout, applied once the rebuilt scene is ready
    const pendingCameraRef = useRef<SceneLayout['camera'] | null>(initialLayout?.camera ?? null);

    /** Current placements set by hand, settings and camera (reported to the project) */
    const currentLayout = (): SceneLayout => {
        const s = sceneRef.current;
        const byId = new Map(positionedModels.map(m => [m.id, m]));
        return {
            settings: { depthScale, perspective, applyAlignment, pointSize },
            camera: s ? {
                position: s.camera.position.toArray() as [number, number, number],
                target: s.controls.target.toArray() as [number, number, number],
                fov: s.camera.fov,
            } : pendingCameraRef.current ?? initialLayout?.camera,
            models: [...layoutRef.current].flatMap(([id, t]) => {
                const model = byId.get(id);
                const kept = initialLayout?.models.find(m => m.id === id);
                // Placements of models not in this scene (not selected) are kept as they were
                const label = model?.label ?? kept?.label;
                return label ? [{ id, label, box_2d: model?.box_2d ?? kept?.box_2d, ...t }] : [];
            }),
        };
    };
    // Called from event handlers of the scene, which outlive a render: always use the latest
    const reportLayoutRef = useRef<() => void>(() => {});
    reportLayoutRef.current = () => onLayoutChange?.(currentLayout());

    /** Record an edit (a new edit clears the redo history) */
    const pushStepRef = useRef<(step: EditStep | EditStep[]) => void>(() => {});
    pushStepRef.current = (step) => {
        const group = Array.isArray(step) ? step : [step];
        if (group.length === 0) return;
        undoStackRef.current.push(group);
        if (undoStackRef.current.length > 100) undoStackRef.current.shift();
        redoStackRef.current = [];
        updateHistorySize();
    };

    /** Put a model at a placement (undefined = its automatic placement) */
    const placeModel = (modelId: string, t?: SavedTransform) => {
        const container = meshContainersRef.current.find(c => c.userData.modelId === modelId);
        if (t) layoutRef.current.set(modelId, t);
        else layoutRef.current.delete(modelId);
        const target = t ?? container?.userData.autoTransform;
        if (container && target) applyTransform(container, target);
    };

    const undoRef = useRef<() => void>(() => {});
    undoRef.current = () => {
        const group = undoStackRef.current.pop();
        if (!group) return;
        for (const step of [...group].reverse()) placeModel(step.modelId, step.before);
        redoStackRef.current.push(group);
        updateHistorySize();
        reportLayoutRef.current();
    };
    const redoRef = useRef<() => void>(() => {});
    redoRef.current = () => {
        const group = redoStackRef.current.pop();
        if (!group) return;
        for (const step of group) placeModel(step.modelId, step.after);
        undoStackRef.current.push(group);
        updateHistorySize();
        reportLayoutRef.current();
    };

    /**
     * Arrange: let Claude move, turn and scale the models so that the scene matches the
     * photo (supports, seated people, relative sizes, orientation). The result becomes
     * placements set by hand and one Undo step.
     */
    const handleArrange = async () => {
        if (arranging) return;
        if (!claudeApiKey) {
            alert('Arrange uses Claude (Anthropic API). Enter an Anthropic API key in AI Settings.');
            onOpenSettings?.();
            return;
        }
        const render = arrangeRenderRef.current;
        if (!render) return;
        const entries = positionedModels.flatMap((model) => {
            const container = meshContainersRef.current.find(c => c.userData.modelId === model.id);
            return container ? [{ model, container }] : [];
        });
        if (entries.length === 0) return;
        // Short ids for Claude (o1, o2, ...)
        const shortId = new Map(entries.map((e, i) => [e.model.id, `o${i + 1}`]));
        const byShort = new Map(entries.map((e, i) => [`o${i + 1}`, e]));
        const describe = (model: Model3D) => model.box_2d
            ? detectedObjects.find(o => sameBox(o.box_2d, model.box_2d!))?.description
            : undefined;
        const nameOf = (model: Model3D) => `${shortId.get(model.id)} ${model.label.replace(/\s*\(Completed\)\s*$/i, '')}`;
        const boxOf = (o: THREE.Object3D) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); };
        const before = new Map(entries.map(e => [e.model.id, layoutRef.current.get(e.model.id)]));
        // Floor: the bottom of the point cloud is only the lower edge of the photo (often a
        // table top or people's laps), so use the lowest model instead (completed people
        // have their feet, furniture its legs)
        const floorY = Math.min(...entries.map(e => boxOf(e.container).min.y));
        floorYRef.current = floorY;
        if (gridRef.current) gridRef.current.position.y = floorY;

        const arrangeScene: ArrangeScene = {
            objects: (): ArrangeObject[] => entries.map(({ model, container }) => {
                const b = boxOf(container);
                const c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
                return {
                    id: shortId.get(model.id)!,
                    label: model.label.replace(/\s*\(Completed\)\s*$/i, ''),
                    description: describe(model),
                    type: model.type,
                    photoBox: model.box_2d,
                    center: c.toArray() as [number, number, number],
                    size: sz.toArray() as [number, number, number],
                    rotationYDeg: container.rotation.y * 180 / Math.PI,
                };
            }),
            floorY: () => floorY,
            apply: (edits: PlacementEdit[]) => {
                const problems: string[] = [];
                const shiftCenterTo = (o: THREE.Object3D, target: THREE.Vector3) => {
                    o.position.add(target.clone().sub(boxOf(o).getCenter(new THREE.Vector3())));
                };
                for (const edit of edits) {
                    const entry = byShort.get(edit.id);
                    if (!entry) { problems.push(`unknown id ${edit.id}`); continue; }
                    const o = entry.container;
                    if (edit.scale !== undefined) {
                        const c = boxOf(o).getCenter(new THREE.Vector3());
                        o.scale.multiplyScalar(edit.scale);
                        shiftCenterTo(o, c);
                    }
                    if (edit.scale_axes) {
                        // Stretch along the model's own axes (e.g. a table generated too low)
                        const c = boxOf(o).getCenter(new THREE.Vector3());
                        o.scale.multiply(new THREE.Vector3(...edit.scale_axes));
                        shiftCenterTo(o, c);
                    }
                    if (edit.rotate_y_deg !== undefined) {
                        const c = boxOf(o).getCenter(new THREE.Vector3());
                        o.rotation.y += edit.rotate_y_deg * Math.PI / 180;
                        shiftCenterTo(o, c);
                    }
                    if (edit.along_ray !== undefined) {
                        const c = boxOf(o).getCenter(new THREE.Vector3());
                        o.scale.multiplyScalar(edit.along_ray);
                        shiftCenterTo(o, c.multiplyScalar(edit.along_ray));
                    }
                    if (edit.move) o.position.add(new THREE.Vector3(...edit.move));
                    if (edit.center) shiftCenterTo(o, new THREE.Vector3(...edit.center));
                    if (edit.rest_on !== undefined) {
                        let top: number | undefined;
                        if (edit.rest_on === 'floor') top = floorY;
                        else {
                            const support = byShort.get(edit.rest_on);
                            if (support && support !== entry) top = boxOf(support.container).max.y;
                            else problems.push(`${edit.id}: unknown support ${edit.rest_on}`);
                        }
                        if (top !== undefined) {
                            // Slide the object along the line of sight until its bottom touches the
                            // support (scaling it with the distance), so that it keeps its place in
                            // the photo: a cup seen on the near edge of the table lands on the near
                            // edge, not wherever the depth estimate put it. If the line of sight
                            // does not reach the support plane, drop it vertically instead.
                            const b = boxOf(o);
                            const bottom = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
                            const t = bottom.y !== 0 ? top / bottom.y : NaN;
                            if (Number.isFinite(t) && t > 0.25 && t < 4) {
                                const c = b.getCenter(new THREE.Vector3());
                                o.scale.multiplyScalar(t);
                                shiftCenterTo(o, c.multiplyScalar(t));
                                o.position.y += top - boxOf(o).min.y; // exact contact
                            } else {
                                o.position.y += top - b.min.y;
                                problems.push(`${edit.id}: the line of sight does not reach the support, so it was moved vertically (its place in the photo changed)`);
                            }
                        }
                    }
                    o.updateMatrixWorld(true);
                    layoutRef.current.set(entry.model.id, transformOf(o));
                }
                return problems;
            },
            render: async (view) => render(view, entries.map(({ model, container }) => ({
                text: nameOf(model),
                center: boxOf(container).getCenter(new THREE.Vector3()),
            }))),
        };

        transformControlsRef.current?.detach();
        setSelectedModelIndex(-1);
        const controller = new AbortController();
        arrangeAbortRef.current = controller;
        setArranging(true);
        setArrangeLog(['Starting…']);
        const log = (m: string) => setArrangeLog(prev => [...prev.slice(-30), m]);
        try {
            const result = await arrangeSceneWithClaude(arrangeScene, {
                apiKey: claudeApiKey,
                model: claudeModel || 'claude-opus-5-5',
                photoUrl: imageUrl,
                signal: controller.signal,
                onProgress: log,
            });
            log(`Done (${result.rounds} round${result.rounds === 1 ? '' : 's'}). ${result.summary}`);
        } catch (e: any) {
            log(controller.signal.aborted ? 'Cancelled.' : `Failed: ${e?.message || e}`);
            console.error('Arrange failed:', e);
        } finally {
            // Whatever was changed is one Undo step
            const steps: EditStep[] = entries.flatMap(({ model, container }) => {
                const after = transformOf(container);
                const prev = before.get(model.id);
                return sameTransform(prev ?? container.userData.autoTransform, after) ? [] : [{ modelId: model.id, before: prev, after }];
            });
            pushStepRef.current(steps);
            reportLayoutRef.current();
            arrangeAbortRef.current = null;
            setArranging(false);
        }
    };

    // Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) in edit mode; Cmd on macOS
    useEffect(() => {
        if (!editMode) return;
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            const key = e.key.toLowerCase();
            if (key === 'z' && !e.shiftKey) { e.preventDefault(); undoRef.current(); }
            else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redoRef.current(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [editMode]);

    // Store references for dynamic updates
    const sceneRef = useRef<{
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        renderer: THREE.WebGLRenderer;
        points: THREE.Points | null;
        controls: OrbitControls;
        boundingBoxGroup: THREE.Group | null;
        modelsGroup: THREE.Group | null;
        modelBoxesGroup: THREE.Group | null;
        wholeModelBoxesGroup: THREE.Group | null;
        transformControls: TransformControls | null;
        depthCanvas: HTMLCanvasElement | null;
        depthCtx: CanvasRenderingContext2D | null;
    } | null>(null);

    // Report setting changes to the project
    useEffect(() => {
        reportLayoutRef.current();
    }, [depthScale, perspective, applyAlignment, pointSize]);

    // Update point size dynamically
    useEffect(() => {
        if (sceneRef.current?.points) {
            const material = sceneRef.current.points.material as THREE.PointsMaterial;
            material.size = pointSize * 0.01;
            material.needsUpdate = true;
        }
    }, [pointSize]);



    // Toggle bounding box visibility
    useEffect(() => {
        if (sceneRef.current?.boundingBoxGroup) {
            sceneRef.current.boundingBoxGroup.visible = showBoxes;
        }
    }, [showBoxes]);

    // Sync showPointCloudRef with state (ensures ref is always current for scene rebuilds)
    useEffect(() => {
        showPointCloudRef.current = showPointCloud;
    }, [showPointCloud]);

    // Toggle point cloud visibility
    useEffect(() => {
        // Apply visibility immediately
        if (sceneRef.current?.points) {
            sceneRef.current.points.visible = showPointCloud;
        }
        // Apply after short delay to catch async point cloud creation
        const timeoutId1 = setTimeout(() => {
            if (sceneRef.current?.points) {
                sceneRef.current.points.visible = showPointCloud;
            }
        }, 100);
        // Apply after longer delay for slow point cloud creation
        const timeoutId2 = setTimeout(() => {
            if (sceneRef.current?.points) {
                sceneRef.current.points.visible = showPointCloud;
            }
        }, 500);
        return () => {
            clearTimeout(timeoutId1);
            clearTimeout(timeoutId2);
        };
    }, [showPointCloud]);

    // Toggle 3D models visibility
    useEffect(() => {
        if (sceneRef.current?.modelsGroup) {
            sceneRef.current.modelsGroup.visible = showModelsToggle;
        }
    }, [showModelsToggle]);

    // Toggle model bounding boxes visibility
    useEffect(() => {
        if (sceneRef.current?.modelBoxesGroup) {
            sceneRef.current.modelBoxesGroup.visible = showModelBoxes;
        }
    }, [showModelBoxes]);

    // Toggle whole model bounding boxes visibility
    useEffect(() => {
        if (sceneRef.current?.wholeModelBoxesGroup) {
            sceneRef.current.wholeModelBoxesGroup.visible = showWholeModelBoxes;
        }
    }, [showWholeModelBoxes]);

    // Sync wholeModelBoxesRef with state
    useEffect(() => {
        showWholeModelBoxesRef.current = showWholeModelBoxes;
    }, [showWholeModelBoxes]);

    // Update TransformControls mode when transformMode changes
    useEffect(() => {
        if (transformControlsRef.current) {
            transformControlsRef.current.setMode(transformMode);
        }
    }, [transformMode]);

    // Reattach TransformControls when selectedModelIndex changes or after scene rebuild
    useEffect(() => {
        if (selectedModelIndex >= 0 && transformControlsRef.current && meshContainersRef.current[selectedModelIndex]) {
            transformControlsRef.current.attach(meshContainersRef.current[selectedModelIndex]);
        } else if (selectedModelIndex < 0 && transformControlsRef.current) {
            transformControlsRef.current.detach();
        }
    }, [selectedModelIndex]);

    // When Edit Mode changes, adjust visibility settings
    useEffect(() => {
        // Sync ref for use in click handler closure
        editModeRef.current = editMode;

        if (editMode) {
            // Edit ON: Turn off Model Boxes, Point Cloud, PC Boxes (keep 3D Models and Whole Boxes)
            setShowModelBoxes(false);
            showModelBoxesRef.current = false;
            if (sceneRef.current?.modelBoxesGroup) {
                sceneRef.current.modelBoxesGroup.visible = false;
            }
            setShowPointCloud(false);
            showPointCloudRef.current = false;
            if (sceneRef.current?.points) {
                sceneRef.current.points.visible = false;
            }
            setShowBoxes(false);
            showBoxesRef.current = false;
            if (sceneRef.current?.boundingBoxGroup) {
                sceneRef.current.boundingBoxGroup.visible = false;
            }
            // Apply point cloud visibility after delays to catch async creation
            const timeoutIds = [100, 300, 500, 1000].map((delay) =>
                setTimeout(() => {
                    if (sceneRef.current?.points) {
                        sceneRef.current.points.visible = false;
                    }
                }, delay)
            );
            return () => timeoutIds.forEach(clearTimeout);
        } else {
            // Edit OFF: Detach TransformControls and clear selection
            if (transformControlsRef.current) {
                transformControlsRef.current.detach();
                setSelectedModelIndex(-1);
                // Reset all whole box highlights to orange
                wholeBoxContainersRef.current.forEach((wholeBox) => {
                    if (wholeBox && wholeBox.children[0]) {
                        const lineSegments = wholeBox.children[0] as THREE.LineSegments;
                        if (lineSegments.material) {
                            const mat = lineSegments.material as THREE.LineBasicMaterial;
                            mat.color.setHex(0xf97316);
                        }
                    }
                });
            }
        }
    }, [editMode]);

    const fileStamp = () => {
        const d = new Date();
        const p2 = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    };
    const fileBase = () => (sceneName || 'scene').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'scene';

    const download = (blob: Blob, name: string) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        URL.revokeObjectURL(url);
    };

    /**
     * Save the scene layout: where each model is (position, rotation, scale), the
     * scene settings and the camera, as a small JSON file. The models themselves are
     * not included; they are in the project, and the layout refers to them by id.
     */
    const handleSaveScene = () => {
        const s = sceneRef.current;
        if (!s) return;
        const byId = new Map(positionedModels.map(m => [m.id, m]));
        const layout: SceneLayoutFile = {
            format: LAYOUT_FORMAT,
            version: 1,
            savedAt: new Date().toISOString(),
            scene: sceneName,
            settings: { depthScale, perspective, applyAlignment, pointSize },
            camera: {
                position: s.camera.position.toArray() as [number, number, number],
                target: s.controls.target.toArray() as [number, number, number],
                fov: s.camera.fov,
            },
            models: meshContainersRef.current.flatMap((container) => {
                const id = container.userData.modelId as string | undefined;
                const model = id ? byId.get(id) : undefined;
                return model ? [{ id: model.id, label: model.label, box_2d: model.box_2d, ...transformOf(container) }] : [];
            }),
        };
        // layout-edited: some models were placed by hand (or by a loaded layout)
        const kind = layoutRef.current.size > 0 ? 'layout-edited' : 'layout';
        download(new Blob([JSON.stringify(layout, null, 1)], { type: 'application/json' }), `${fileBase()}_${kind}_${fileStamp()}.json`);
    };

    /** Export the models as placed in the scene as one GLB file (for other 3D software; large) */
    const handleExportGlb = () => {
        if (!sceneRef.current?.modelsGroup) return;
        new GLTFExporter().parse(
            sceneRef.current.modelsGroup,
            (result) => download(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), `${fileBase()}_scene_${fileStamp()}.glb`),
            (error) => console.error('Error exporting scene:', error),
            { binary: true }
        );
    };

    /** Put the models of the current scene where the layout says (models without an entry keep the automatic placement) */
    const applyLayoutToScene = () => {
        for (const container of meshContainersRef.current) {
            const t = layoutRef.current.get(container.userData.modelId);
            if (t) applyTransform(container, t);
        }
    };

    const applyPendingCamera = () => {
        const s = sceneRef.current;
        const cam = pendingCameraRef.current;
        if (!s || !cam) return;
        s.camera.position.fromArray(cam.position);
        s.controls.target.fromArray(cam.target);
        s.camera.fov = cam.fov;
        s.camera.updateProjectionMatrix();
        s.controls.update();
        pendingCameraRef.current = null;
    };

    /** Load a scene layout (JSON) saved with Save */
    const loadLayout = (text: string) => {
        let layout: SceneLayoutFile;
        try {
            layout = JSON.parse(text);
        } catch {
            alert('This file is not a scene layout (invalid JSON).');
            return;
        }
        if (layout?.format !== LAYOUT_FORMAT || !Array.isArray(layout.models)) {
            alert('This file is not a scene layout saved with Save. (A project file is loaded with Load Project in the header.)');
            return;
        }
        // Match by model id; if the models were generated again, by label and photo box
        const next = new Map<string, SavedTransform>();
        const missing: string[] = [];
        for (const entry of layout.models) {
            if (!isVec3(entry.position) || !isVec3(entry.rotation) || !isVec3(entry.scale)) continue;
            const model = positionedModels.find(m => m.id === entry.id)
                ?? positionedModels.find(m => m.label === entry.label && !!m.box_2d && !!entry.box_2d && sameBox(m.box_2d, entry.box_2d));
            if (model) next.set(model.id, { position: entry.position, rotation: entry.rotation, scale: entry.scale });
            else missing.push(entry.label || entry.id);
        }
        if (next.size === 0) {
            alert('None of the models in this layout are in the current scene.');
            return;
        }
        layoutRef.current = next;
        // A loaded layout replaces all placements; edits before it cannot be undone one by one
        undoStackRef.current = [];
        redoStackRef.current = [];
        updateHistorySize();
        transformControlsRef.current?.detach();
        setSelectedModelIndex(-1);
        if (layout.camera && isVec3(layout.camera.position) && isVec3(layout.camera.target) && typeof layout.camera.fov === 'number') {
            pendingCameraRef.current = layout.camera;
        }

        const st = layout.settings ?? ({} as SceneLayoutFile['settings']);
        if (typeof st.pointSize === 'number') setPointSize(st.pointSize);
        const rebuild = (typeof st.depthScale === 'number' && st.depthScale !== depthScale)
            || (typeof st.perspective === 'boolean' && st.perspective !== perspective)
            || (typeof st.applyAlignment === 'boolean' && st.applyAlignment !== applyAlignment);
        if (rebuild) {
            // The scene is rebuilt with these settings; the models are placed from layoutRef as they load
            if (typeof st.depthScale === 'number') setDepthScale(st.depthScale);
            if (typeof st.perspective === 'boolean') setPerspective(st.perspective);
            if (typeof st.applyAlignment === 'boolean') setApplyAlignment(st.applyAlignment);
        } else {
            applyLayoutToScene();
            applyPendingCamera();
        }
        reportLayoutRef.current();
        if (missing.length > 0) {
            alert(`Layout loaded. Not in the current scene (kept out): ${missing.join(', ')}`);
        }
    };

    // Load a scene layout (JSON, from Save) or a GLB exported with Export GLB
    const handleLoadScene = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.glb,.gltf';
        input.onchange = (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file || !sceneRef.current?.modelsGroup) return;

            const reader = new FileReader();
            if (file.name.toLowerCase().endsWith('.json')) {
                reader.onload = (event) => loadLayout(event.target?.result as string);
                reader.readAsText(file);
                return;
            }
            reader.onload = (event) => {
                const arrayBuffer = event.target?.result as ArrayBuffer;
                const loader = new GLTFLoader();
                loader.parse(arrayBuffer, '', (gltf) => {
                    // Clear existing models
                    const modelsGroup = sceneRef.current!.modelsGroup!;
                    while (modelsGroup.children.length > 0) {
                        modelsGroup.remove(modelsGroup.children[0]);
                    }
                    meshContainersRef.current = [];

                    // Add loaded models
                    gltf.scene.children.forEach((child, index) => {
                        const clone = child.clone();
                        clone.userData.modelIndex = index;
                        modelsGroup.add(clone);
                        if (clone instanceof THREE.Group) {
                            meshContainersRef.current.push(clone);
                        }
                    });

                    // Detach transform controls
                    if (transformControlsRef.current) {
                        transformControlsRef.current.detach();
                    }
                    setSelectedModelIndex(-1);
                }, (error) => {
                    console.error('Error loading scene:', error);
                });
            };
            reader.readAsArrayBuffer(file);
        };
        input.click();
    };

    // Main scene setup effect
    useEffect(() => {
        if (!mountRef.current) return;

        // Set when this scene is torn down. The point cloud and models load
        // asynchronously; a run that finishes after its scene was replaced (React
        // StrictMode mounts twice in development, and the scene is rebuilt when the
        // depth scale or selection changes) must not touch the new scene.
        let disposed = false;

        // Image coordinates (u, v in 0..1) and distance D to scene X/Y.
        // - Perspective (default): back-project through a pinhole camera at the origin
        //   with an assumed horizontal field of view, so objects keep their real
        //   relative size (a near cup is not as large as a far person) and the scene
        //   seen from the photo's camera looks like the photo.
        // - Off: the paper's placement, which keeps every object at its size in the
        //   image regardless of its distance (near objects end up magnified).
        const HFOV_DEG = ASSUMED_HFOV_DEG; // assumed, as in the front alignment's view angle
        const tanHalf = Math.tan((HFOV_DEG / 2) * Math.PI / 180);
        // Vertical field of view (degrees) of the initial "photo camera" view for a canvas
        // of the given aspect: the whole photo frame fits, with a margin for the control
        // panel over the top of the canvas.
        const VIEW_MARGIN = 1.35;
        const photoViewFov = (canvasAspect: number): number => {
            const tanV = Math.max(tanHalf / originalAspectRatio, tanHalf / canvasAspect) * VIEW_MARGIN;
            return 2 * Math.atan(tanV) * 180 / Math.PI;
        };
        let inPhotoView = false; // camera still at the photo's camera, so resizes refit the FOV
        const toWorldXY = (u: number, v: number, depth: number): [number, number] => perspective
            ? [(u - 0.5) * 2 * tanHalf * depth, -(v - 0.5) * 2 * (tanHalf / originalAspectRatio) * depth]
            : [(u - 0.5) * 2 * originalAspectRatio, -(v - 0.5) * 2];
        const toWorldZ = (depth: number): number => perspective ? -depth : -depth * depthScale;

        // Depth range. Depth Anything V2 stretches its disparity over 0..255 for every
        // image, so only the ratio far/near is unknown. With perspective, the Depth
        // slider sets that ratio (1 + slider; default 1.5, measured on the sample photo:
        // it makes a cup's size relative to a person's head realistic). Without, the
        // paper's linear mapping to 0.5..5.0 is scaled by the slider along Z only.
        const depthRange: DepthRange = perspective
            ? { min: 1, max: 1 + depthScale, inverse: true }
            : { min: 0.5, max: 5.0 };

        // Clear any existing canvas
        mountRef.current.innerHTML = '';

        // Scene setup
        const scene = new THREE.Scene();

        // Camera
        const camera = new THREE.PerspectiveCamera(
            60,
            mountRef.current.clientWidth / mountRef.current.clientHeight,
            0.1,
            1000
        );
        camera.position.set(0, 0, 3);

        // Renderer with proper color management for TRELLIS.2 textures
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        // Enable proper sRGB color space output
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        // Use ACES Filmic tone mapping for more natural colors
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.5; // Increase exposure to brighten textures
        mountRef.current.appendChild(renderer.domElement);

        // Controls
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        // Remember the view when the user stops turning or zooming
        controls.addEventListener('end', () => reportLayoutRef.current());
        controls.dampingFactor = 0.05;
        controls.target.set(0, 0, 0);

        // White background
        scene.background = new THREE.Color(0xffffff);

        // Lights - Enhanced for brighter textures
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
        directionalLight.position.set(5, 10, 5);
        scene.add(directionalLight);

        // Fill lights from multiple directions
        const fillLight1 = new THREE.DirectionalLight(0xffffff, 0.6);
        fillLight1.position.set(-5, 5, -5);
        scene.add(fillLight1);

        const fillLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
        fillLight2.position.set(0, -5, 10);
        scene.add(fillLight2);

        // Grid Helper (Mesh Plane)
        const gridHelper = new THREE.GridHelper(10, 20, 0xcccccc, 0xe0e0e0);
        gridHelper.position.y = -1; // Position below the scene
        scene.add(gridHelper);
        floorYRef.current = -1;
        gridRef.current = gridHelper;

        // Bounding box group
        const boundingBoxGroup = new THREE.Group();
        boundingBoxGroup.visible = showBoxesRef.current;
        scene.add(boundingBoxGroup);

        // 3D Models group
        const modelsGroup = new THREE.Group();
        modelsGroup.visible = showModelsRef.current;
        scene.add(modelsGroup);

        // Model bounding boxes group (green boxes for 3D models)
        const modelBoxesGroup = new THREE.Group();
        modelBoxesGroup.visible = showModelBoxesRef.current;
        scene.add(modelBoxesGroup);

        // Whole model bounding boxes group (orange boxes for entire 3D models)
        const wholeModelBoxesGroup = new THREE.Group();
        wholeModelBoxesGroup.visible = showWholeModelBoxesRef.current;
        scene.add(wholeModelBoxesGroup);

        // TransformControls for object manipulation
        const transformControls = new TransformControls(camera, renderer.domElement);
        transformControls.setSize(1); // Standard gizmo size
        transformControls.addEventListener('dragging-changed', (event: { value: boolean }) => {
            controls.enabled = !event.value; // Disable OrbitControls while transforming
            if (event.value) {
                // Dragging started
                isDraggingRef.current = true;
            } else {
                // Remember the placement set by hand, so that it survives scene rebuilds and is saved with Save
                const edited = transformControls.object;
                if (edited?.userData.modelId) {
                    const after = transformOf(edited);
                    const start = dragStartRef.current;
                    const before = start?.modelId === edited.userData.modelId ? start.before : undefined;
                    const unchanged = sameTransform(before ?? edited.userData.autoTransform, after);
                    if (!unchanged) {
                        layoutRef.current.set(edited.userData.modelId, after);
                        pushStepRef.current({ modelId: edited.userData.modelId, before, after });
                        reportLayoutRef.current();
                    }
                }
                dragStartRef.current = null;
                // Dragging ended - keep isDraggingRef true for a short time to block click events
                setTimeout(() => {
                    isDraggingRef.current = false;
                }, 200);
            }
        });
        // Uniform scale: dragging the handle of one axis scales all three axes by the
        // same factor, relative to the scale when the drag started
        let scaleAtDragStart: THREE.Vector3 | null = null;
        transformControls.addEventListener('mouseDown', () => {
            const obj = transformControls.object;
            scaleAtDragStart = obj ? obj.scale.clone() : null;
            // For Undo: the placement before this drag (a manual one, or none = automatic)
            const id = obj?.userData.modelId as string | undefined;
            dragStartRef.current = id ? { modelId: id, before: layoutRef.current.get(id) } : null;
        });
        transformControls.addEventListener('objectChange', () => {
            const obj = transformControls.object;
            const axis = transformControls.axis;
            if (!uniformScaleRef.current || transformControls.getMode() !== 'scale' || !obj || !axis || !scaleAtDragStart) return;
            const c = axis.includes('X') ? 'x' : axis.includes('Y') ? 'y' : 'z';
            if (Math.abs(scaleAtDragStart[c]) < 1e-9) return;
            const factor = obj.scale[c] / scaleAtDragStart[c];
            obj.scale.copy(scaleAtDragStart).multiplyScalar(factor);
        });
        // Use getHelper() to get the gizmo object that can be added to scene
        // This fixes the issue with multiple Three.js instances
        const transformHelper = transformControls.getHelper();
        scene.add(transformHelper);
        transformControlsRef.current = transformControls;

        // Renderings for Arrange: from the photo's camera, or from above, with only the
        // models and the floor grid, and the object names drawn on them. Rendered into
        // the visible canvas at another size and copied at once (before the browser
        // presents the frame); the animation loop draws the normal view again.
        arrangeRenderRef.current = (view, labels) => {
            const W = 1024;
            const photoAspect = originalAspectRatio;
            const H = view === 'photo' ? Math.round(W / photoAspect) : W;
            let cam: THREE.Camera;
            if (view === 'photo') {
                const pc = new THREE.PerspectiveCamera(2 * Math.atan(tanHalf / photoAspect) * 180 / Math.PI, photoAspect, 0.01, 1000);
                pc.position.set(0, 0, 0);
                pc.lookAt(0, 0, -1);
                cam = pc;
            } else {
                const b = new THREE.Box3().setFromObject(modelsGroup);
                const c = b.getCenter(new THREE.Vector3());
                const half = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.6 + 0.05;
                const oc = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, 1000);
                oc.position.set(c.x, b.max.y + 10, c.z);
                oc.up.set(0, 0, -1); // away from the photo's camera is up in the image
                oc.lookAt(c.x, b.min.y, c.z);
                cam = oc;
            }
            cam.updateMatrixWorld();
            const hidden = [boundingBoxGroup, modelBoxesGroup, wholeModelBoxesGroup, transformHelper, sceneRef.current?.points]
                .filter((o): o is THREE.Object3D => !!o && o.visible);
            hidden.forEach(o => { o.visible = false; });
            const modelsVisible = modelsGroup.visible;
            modelsGroup.visible = true;
            const prevSize = renderer.getSize(new THREE.Vector2());
            const prevRatio = renderer.getPixelRatio();
            renderer.setPixelRatio(1);
            renderer.setSize(W, H, false);
            renderer.render(scene, cam);
            const out = document.createElement('canvas');
            out.width = W; out.height = H;
            const ctx = out.getContext('2d')!;
            ctx.drawImage(renderer.domElement, 0, 0, W, H);
            renderer.setPixelRatio(prevRatio);
            renderer.setSize(prevSize.x, prevSize.y, false);
            hidden.forEach(o => { o.visible = true; });
            modelsGroup.visible = modelsVisible;
            // Object names at the projected centers
            ctx.font = 'bold 18px sans-serif';
            ctx.textBaseline = 'middle';
            for (const { text, center } of labels) {
                const p = center.clone().project(cam);
                if (p.z < -1 || p.z > 1) continue;
                const w = ctx.measureText(text).width + 8;
                // Keep the label inside the image (objects cut off at the border)
                const x = Math.min(Math.max((p.x + 1) / 2 * W, w / 2), W - w / 2);
                const y = Math.min(Math.max((1 - p.y) / 2 * H, 12), H - 12);
                ctx.fillStyle = 'rgba(0,0,0,0.65)';
                ctx.fillRect(x - w / 2, y - 12, w, 24);
                ctx.fillStyle = '#fff';
                ctx.fillText(text, x - w / 2 + 4, y);
            }
            return out.toDataURL('image/jpeg', 0.85).split(',')[1];
        };

        // Clear mesh containers and whole box containers for new scene
        meshContainersRef.current = [];
        wholeBoxContainersRef.current = [];

        // Store refs for dynamic updates
        sceneRef.current = { scene, camera, renderer, points: null, controls, boundingBoxGroup, modelsGroup, modelBoxesGroup, wholeModelBoxesGroup, transformControls, depthCanvas: null, depthCtx: null };

        // Load images and create point cloud
        const loadPointCloud = async () => {
            try {
                // Load both images
                const [colorImg, depthImg] = await Promise.all([
                    loadImageAsync(imageUrl),
                    loadImageAsync(depthMapUrl)
                ]);
                if (disposed) return;

                // Use a reasonable resolution for the point cloud
                const resolution = 256; // Number of points per dimension
                const width = resolution;
                const height = Math.round(resolution / originalAspectRatio);

                // Create canvases for sampling
                const colorCanvas = document.createElement('canvas');
                colorCanvas.width = width;
                colorCanvas.height = height;
                const colorCtx = colorCanvas.getContext('2d')!;
                colorCtx.drawImage(colorImg, 0, 0, width, height);
                const colorData = colorCtx.getImageData(0, 0, width, height);

                const depthCanvas = document.createElement('canvas');
                depthCanvas.width = width;
                depthCanvas.height = height;
                const depthCtx = depthCanvas.getContext('2d')!;
                depthCtx.drawImage(depthImg, 0, 0, width, height);
                const depthData = depthCtx.getImageData(0, 0, width, height);

                // Store depth canvas for bounding box calculations
                if (sceneRef.current) {
                    sceneRef.current.depthCanvas = depthCanvas;
                    sceneRef.current.depthCtx = depthCtx;
                }

                // Create geometry
                const positions: number[] = [];
                const colors: number[] = [];


                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const idx = (y * width + x) * 4;

                        // Depth from brightness (R channel; white = near), then X/Y from the pixel position
                        const depth = depthFromBrightness(depthData.data[idx], depthRange);
                        const z = toWorldZ(depth);
                        const [xPos, yPos] = toWorldXY(x / width, y / height, depth);

                        positions.push(xPos, yPos, z);

                        // Get color
                        const r = colorData.data[idx] / 255;
                        const g = colorData.data[idx + 1] / 255;
                        const b = colorData.data[idx + 2] / 255;
                        colors.push(r, g, b);
                    }
                }

                // Create BufferGeometry
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

                // Create material
                const material = new THREE.PointsMaterial({
                    size: pointSize * 0.01,
                    vertexColors: true,
                    sizeAttenuation: true
                });

                // Create points
                const points = new THREE.Points(geometry, material);
                scene.add(points);

                // Store reference
                if (sceneRef.current) {
                    sceneRef.current.points = points;
                    // Apply current visibility state
                    points.visible = showPointCloudRef.current;
                }

                // Alpha masks for Eq. (4): photo masks (SAM) or the models' background-removed images
                const masks = await loadSceneMasks(positionedModels, detectedObjects);
                if (disposed) return;

                // Create PC Boxes for detected objects
                createBoundingBoxes(depthData, depthRange, masks);

                // Load 3D models and position them
                loadModels(depthData, depthRange, masks.byModel);

                // Adjust camera to view the point cloud
                const box = new THREE.Box3().setFromObject(points);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);

                if (perspective) {
                    // Start from the photo's camera: at the origin, with the assumed field of view
                    camera.fov = photoViewFov(camera.aspect);
                    inPhotoView = true;
                    camera.near = 0.01;
                    camera.updateProjectionMatrix();
                    camera.position.set(0, 0, 0);
                    controls.target.set(0, 0, center.z);
                    gridHelper.position.y = box.min.y; // floor under the scene
                    floorYRef.current = box.min.y;
                } else {
                    camera.position.set(center.x, center.y, center.z + maxDim * 1.5);
                    controls.target.copy(center);
                }
                controls.update();

                // Camera of a layout loaded with other settings (the scene was rebuilt for it)
                const savedCamera = pendingCameraRef.current;
                if (savedCamera) {
                    camera.position.fromArray(savedCamera.position);
                    controls.target.fromArray(savedCamera.target);
                    camera.fov = savedCamera.fov;
                    camera.updateProjectionMatrix();
                    controls.update();
                    inPhotoView = false;
                    pendingCameraRef.current = null;
                    reportLayoutRef.current();
                }

                setLoading(false);
            } catch (error) {
                console.error('Failed to load point cloud:', error);
                setLoading(false);
            }
        };

        const createBoundingBoxes = (
            depthData: ImageData,
            depthRange: DepthRange,
            masks: { byModel: Map<string, ObjectMask>; byBox: Map<string, ObjectMask> }
        ) => {
            if (disposed || detectedObjects.length === 0) return;

            const group = boundingBoxGroup;
            // Clear existing boxes
            while (group.children.length > 0) {
                group.remove(group.children[0]);
            }

            detectedObjects.forEach((obj) => {
                const [ymin, xmin, ymax, xmax] = obj.box_2d;

                // Eq. (4): median depth of the object's mask. The mask comes from the
                // 3D model generated from this object (same box), if there is one.
                const model = positionedModels.find(m => m.box_2d && sameBox(m.box_2d, obj.box_2d));
                const mask = (model ? masks.byModel.get(model.id) : undefined) ?? masks.byBox.get(boxKey(obj.box_2d));
                const medianDepth = medianDepthInBox(depthData, obj.box_2d, depthRange, mask).z;
                const zPos = toWorldZ(medianDepth);

                // Calculate 3D position and size (at the object's depth)
                const [x3dMin, y3dMin] = toWorldXY(xmin, ymax, medianDepth);
                const [x3dMax, y3dMax] = toWorldXY(xmax, ymin, medianDepth);

                const boxWidth = x3dMax - x3dMin;
                const boxHeight = y3dMax - y3dMin;
                const boxDepth = perspective ? 0.02 : 0.1 * depthScale; // Thin depth for visibility

                // Create box geometry
                const boxGeometry = new THREE.BoxGeometry(boxWidth, boxHeight, boxDepth);
                const edges = new THREE.EdgesGeometry(boxGeometry);
                const color = 0x3b82f6; // Uniform blue color for all PC boxes
                const lineMaterial = new THREE.LineBasicMaterial({ color, linewidth: 2 });
                const wireframe = new THREE.LineSegments(edges, lineMaterial);

                // Position the box
                const xCenter = (x3dMin + x3dMax) / 2;
                const yCenter = (y3dMin + y3dMax) / 2;
                wireframe.position.set(xCenter, yCenter, zPos);

                group.add(wireframe);
            });
        };

        // Load 3D models and position them using the same coordinate system as bounding boxes
        const loadModels = (
            depthData: ImageData,
            depthRange: DepthRange,
            masks: Map<string, ObjectMask>
        ) => {
            if (disposed || positionedModels.length === 0) return;

            // Increment load version to invalidate any in-flight async loads
            loadVersionRef.current++;
            const thisLoadVersion = loadVersionRef.current;

            const group = modelsGroup;
            const boxGroup = modelBoxesGroup;
            const wholeBoxGroup = wholeModelBoxesGroup;
            // Clear existing models
            while (group.children.length > 0) {
                group.remove(group.children[0]);
            }
            // Clear existing model boxes
            while (boxGroup.children.length > 0) {
                boxGroup.remove(boxGroup.children[0]);
            }
            // Clear existing whole model boxes
            while (wholeBoxGroup.children.length > 0) {
                wholeBoxGroup.remove(wholeBoxGroup.children[0]);
            }
            // Clear mesh containers ref for new load
            meshContainersRef.current = [];

            const loader = new GLTFLoader();

            positionedModels.forEach((model) => {
                if (!model.glbUrl) return;

                // Use model's box_2d directly (it's the source of truth for this model's position)
                let [ds_ymin, ds_xmin, ds_ymax, ds_xmax] = model.box_2d || [0, 0, 1, 1];

                // Eq. (4): median depth of the non-transparent pixels of the model's
                // background-removed image (same Z as the object's PC Box)
                const medianDepth = medianDepthInBox(depthData, [ds_ymin, ds_xmin, ds_ymax, ds_xmax], depthRange, masks.get(model.id)).z;
                const zPos = toWorldZ(medianDepth);

                // Calculate 3D position (same as bounding boxes)
                const [x3dMin, y3dMin] = toWorldXY(ds_xmin, ds_ymax, medianDepth);
                const [x3dMax, y3dMax] = toWorldXY(ds_xmax, ds_ymin, medianDepth);

                const boxWidth = x3dMax - x3dMin;
                const boxHeight = y3dMax - y3dMin;
                const xCenter = (x3dMin + x3dMax) / 2;
                const yCenter = (y3dMin + y3dMax) / 2;

                // Load and position the model
                loader.load(model.glbUrl, (gltf) => {
                    // Skip if this scene was torn down or a newer load has started (prevents model duplication)
                    if (disposed || thisLoadVersion !== loadVersionRef.current) return;

                    const mesh = gltf.scene;
                    const meshContainer = new THREE.Group();

                    // Drop tiny stray fragments so that they do not stretch the bounds used for placement
                    removeStrayFragments(mesh);

                    // Step 1: Get original mesh bounds and center at origin
                    mesh.updateMatrixWorld(true);
                    const meshBox = new THREE.Box3().setFromObject(mesh);
                    const meshSize = new THREE.Vector3();
                    meshBox.getSize(meshSize);
                    const meshCenter = new THREE.Vector3();
                    meshBox.getCenter(meshCenter);

                    // Center mesh at origin
                    mesh.position.sub(meshCenter);
                    // TRELLIS.2 and Hunyuan3D-2.1 models already face the camera (+Z); older TripoSR models need a 180° turn
                    if (model.provider !== 'trellis' && model.provider !== 'hunyuan3d') {
                        mesh.rotation.y = Math.PI; // Face camera for other providers
                    }
                    // Front alignment: turn the model so that its front view is the completed image
                    const aligned = applyAlignment && !!model.frontAlignment && model.frontAlignment.score >= MIN_ALIGNMENT_SCORE;
                    if (aligned) mesh.rotation.y += alignmentYawDeg(model.frontAlignment) * Math.PI / 180;
                    // The completed image shows the object as seen from the photo's camera, so an
                    // aligned model is also turned by the view angle (objects away from the image
                    // center are seen obliquely). Applied before the bounds are measured, so the
                    // scale fit uses the box of the rotated model.
                    if (aligned && perspective) mesh.rotation.y += viewAngleDeg(model.box_2d) * Math.PI / 180;

                    // Fix texture color space for proper color rendering
                    mesh.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh) {
                            const meshChild = child as THREE.Mesh;
                            // Handle both single material and material array
                            const materials = Array.isArray(meshChild.material)
                                ? meshChild.material
                                : [meshChild.material];

                            materials.forEach((mat) => {
                                const material = mat as THREE.MeshStandardMaterial;
                                if (!material) return;

                                // Fix color textures to sRGB
                                if (material.map) {
                                    material.map.colorSpace = THREE.SRGBColorSpace;
                                    material.map.needsUpdate = true;
                                }
                                if (material.emissiveMap) {
                                    material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
                                    material.emissiveMap.needsUpdate = true;
                                }

                                // Force material update
                                material.needsUpdate = true;
                            });
                        }
                    });

                    mesh.updateMatrixWorld(true);
                    meshContainer.add(mesh);

                    // Step 2: Calculate green box on centered mesh (BEFORE any scaling)
                    // (precise bounds when rotated: the default box of a rotated mesh is too large)
                    const centeredBox = new THREE.Box3().setFromObject(mesh, mesh.rotation.y !== 0);
                    const centeredSize = new THREE.Vector3();
                    centeredBox.getSize(centeredSize);
                    const cWidth = centeredSize.x;
                    const cHeight = centeredSize.y;
                    const cDepth = centeredSize.z;
                    const centeredCenter = new THREE.Vector3();
                    centeredBox.getCenter(centeredCenter);

                    // Calculate green box dimensions (relative to mesh)
                    let gLocalMinX = centeredBox.min.x;
                    let gLocalMaxX = centeredBox.max.x;
                    let gLocalMinY = centeredBox.min.y;
                    let gLocalMaxY = centeredBox.max.y;

                    if (model.originalPartBox2d && model.tightBox2d) {
                        const [tymin, txmin, tymax, txmax] = model.tightBox2d;
                        const [gymin, gxmin, gymax, gxmax] = model.originalPartBox2d;

                        const meshGlobalWidth = txmax - txmin;
                        const meshGlobalHeight = tymax - tymin;

                        if (meshGlobalWidth > 1e-5 && meshGlobalHeight > 1e-5) {
                            const relXMin = (gxmin - txmin) / meshGlobalWidth;
                            const relXMax = (gxmax - txmin) / meshGlobalWidth;
                            const relYMeanTop = (gymin - tymin) / meshGlobalHeight;
                            const relYMeanBottom = (gymax - tymin) / meshGlobalHeight;

                            // SingleModelViewer logic
                            gLocalMaxY = centeredBox.max.y - (cHeight * relYMeanTop);
                            gLocalMinY = centeredBox.max.y - (cHeight * relYMeanBottom);
                            gLocalMinX = centeredBox.min.x + (cWidth * relXMin);
                            gLocalMaxX = centeredBox.min.x + (cWidth * relXMax);
                        }
                    }

                    const gWidth = gLocalMaxX - gLocalMinX;
                    const gHeight = gLocalMaxY - gLocalMinY;

                    // Step 3: Scale container so GREEN box matches Depth Scene box
                    const scaleX = boxWidth / gWidth;
                    const scaleY = boxHeight / gHeight;
                    const scale = Math.min(scaleX, scaleY);
                    meshContainer.scale.set(scale, scale, scale);

                    // Step 4: Position container so GREEN box front face aligns with PC box
                    // Shift backward by half the scaled depth so the front face aligns
                    const greenLocalCenterX = (gLocalMinX + gLocalMaxX) / 2;
                    const greenLocalCenterY = (gLocalMinY + gLocalMaxY) / 2;
                    const halfDepthOffset = (cDepth * scale) / 2; // Half of scaled depth
                    meshContainer.position.set(
                        xCenter - greenLocalCenterX * scale,
                        yCenter - greenLocalCenterY * scale,
                        zPos - centeredCenter.z * scale - halfDepthOffset
                    );

                    // Move the model's rotation about the vertical axis from the mesh to its container,
                    // keeping the result identical (the scale is uniform, so rotation and scale commute).
                    // The edit controls then move, rotate and scale the container along the model's
                    // own axes, so a non-uniform scale no longer shears a turned model.
                    if (mesh.rotation.y !== 0) {
                        meshContainer.rotation.y = mesh.rotation.y;
                        mesh.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), -mesh.rotation.y);
                        mesh.rotation.y = 0;
                    }

                    // Remember the automatic placement (for Reset), then use a placement set by
                    // hand or loaded from a layout file, if there is one
                    meshContainer.userData.modelId = model.id;
                    meshContainer.userData.autoTransform = transformOf(meshContainer);
                    const savedPlacement = layoutRef.current.get(model.id);
                    if (savedPlacement) applyTransform(meshContainer, savedPlacement);

                    group.add(meshContainer);

                    // Store meshContainer reference and set index for selection
                    const modelIndex = meshContainersRef.current.length;
                    meshContainer.userData.modelIndex = modelIndex;
                    // Propagate modelIndex to all child objects for raycast detection
                    meshContainer.traverse((child) => {
                        child.userData.modelIndex = modelIndex;
                    });
                    meshContainersRef.current.push(meshContainer);

                    // Create green box at the same position as PC box (using boxWidth, boxHeight, xCenter, yCenter)
                    // This ensures Model Box matches PC Box exactly
                    const greenBoxDepth = cDepth * scale * 1.01;
                    const greenGeo = new THREE.BoxGeometry(boxWidth, boxHeight, greenBoxDepth);
                    const greenEdges = new THREE.EdgesGeometry(greenGeo);
                    const greenLine = new THREE.LineSegments(greenEdges, new THREE.LineBasicMaterial({ color: 0x22c55e }));
                    greenLine.position.set(xCenter, yCenter, zPos);
                    boxGroup.add(greenLine);

                    // Create orange box for entire model (wholeModelBoxesGroup)
                    const wholeBoxContainer = new THREE.Group();
                    const wholeGeo = new THREE.BoxGeometry(cWidth, cHeight, cDepth * 1.01);
                    const wholeEdges = new THREE.EdgesGeometry(wholeGeo);
                    const wholeLine = new THREE.LineSegments(wholeEdges, new THREE.LineBasicMaterial({ color: 0xf97316 })); // Orange color
                    wholeLine.position.set(
                        centeredCenter.x,
                        centeredCenter.y,
                        centeredCenter.z
                    );
                    wholeBoxContainer.add(wholeLine);
                    wholeBoxContainer.scale.set(scale, scale, scale);
                    wholeBoxContainer.position.set(
                        xCenter - greenLocalCenterX * scale,
                        yCenter - greenLocalCenterY * scale,
                        zPos - centeredCenter.z * scale - halfDepthOffset
                    );
                    // Mark for selection - store modelIndex
                    wholeBoxContainer.userData.modelIndex = modelIndex;
                    wholeBoxContainer.userData.isSelectableBox = true;
                    wholeBoxContainer.userData.originalColor = 0xf97316; // Store original orange color
                    wholeBoxContainersRef.current.push(wholeBoxContainer);
                    wholeBoxGroup.add(wholeBoxContainer);
                }, undefined, (error) => {
                    console.error(`Failed to load ${model.label}:`, error);
                });
            });
        };

        loadPointCloud();

        // Click handler for object selection
        const handleClick = (event: MouseEvent) => {
            if (!mountRef.current || !sceneRef.current) return;
            // Skip click handling if we just finished dragging (prevents deselection after transform)
            if (isDraggingRef.current) return;
            // Skip selection entirely if not in edit mode (use ref for current value in closure)
            if (!editModeRef.current) return;

            const rect = renderer.domElement.getBoundingClientRect();
            mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            raycasterRef.current.setFromCamera(mouseRef.current, camera);

            // Check intersection with modelsGroup children
            const modelsGroup = sceneRef.current.modelsGroup;
            if (!modelsGroup) return;

            const intersects = raycasterRef.current.intersectObjects(modelsGroup.children, true);

            // Helper to highlight/unhighlight whole box
            const highlightWholeBox = (index: number, highlight: boolean) => {
                const wholeBox = wholeBoxContainersRef.current[index];
                if (wholeBox && wholeBox.children[0]) {
                    const lineSegments = wholeBox.children[0] as THREE.LineSegments;
                    if (lineSegments.material) {
                        const mat = lineSegments.material as THREE.LineBasicMaterial;
                        mat.color.setHex(highlight ? 0xffff00 : 0xf97316); // Yellow when selected, orange otherwise
                        mat.linewidth = highlight ? 3 : 2;
                    }
                }
            };

            // Reset all boxes to original color
            wholeBoxContainersRef.current.forEach((_, idx) => highlightWholeBox(idx, false));

            if (intersects.length > 0) {
                // Find the root meshContainer (parent with modelIndex)
                let obj: THREE.Object3D | null = intersects[0].object;
                while (obj && obj.userData.modelIndex === undefined && obj.parent) {
                    obj = obj.parent;
                }

                if (obj && obj.userData.modelIndex !== undefined) {
                    const modelIndex = obj.userData.modelIndex as number;
                    const meshContainer = meshContainersRef.current[modelIndex];

                    if (meshContainer && transformControlsRef.current) {
transformControlsRef.current.attach(meshContainer);
                        setSelectedModelIndex(modelIndex);
                        // Highlight the selected whole box
                        highlightWholeBox(modelIndex, true);
                    }
                }
            } else {
                // Click on empty space - only deselect if NOT in edit mode
                if (!editMode && transformControlsRef.current) {
                    transformControlsRef.current.detach();
                    setSelectedModelIndex(-1);
                }
            }
        };
        renderer.domElement.addEventListener('click', handleClick);

        // Resize handler. The container can still have zero size when the scene is set
        // up (e.g. while the tab is being laid out), which leaves a 0×0 canvas, so follow
        // the container itself rather than only the window.
        const handleResize = () => {
            if (!mountRef.current) return;
            const width = mountRef.current.clientWidth;
            const height = mountRef.current.clientHeight;
            if (width === 0 || height === 0) return;
            renderer.setSize(width, height);
            camera.aspect = width / height;
            if (inPhotoView) camera.fov = photoViewFov(camera.aspect);
            camera.updateProjectionMatrix();
        };
        window.addEventListener('resize', handleResize);
        const resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(mountRef.current);

        // The browser can drop a WebGL context (e.g. when too many are open), which
        // leaves an empty canvas. Rebuild the scene when that happens.
        const handleContextLost = (event: Event) => {
            event.preventDefault();
            if (disposed) return; // our own forceContextLoss() during cleanup
            console.warn('3D scene: WebGL context lost; rebuilding the scene');
            setContextGeneration(g => g + 1);
        };
        renderer.domElement.addEventListener('webglcontextlost', handleContextLost);

        // Animation loop
        let animationId: number;
        const animate = () => {
            animationId = requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();

        // Cleanup
        return () => {
            disposed = true;
            window.removeEventListener('resize', handleResize);
            resizeObserver.disconnect();
            renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
            renderer.domElement.removeEventListener('click', handleClick);
            cancelAnimationFrame(animationId);
            if (transformControlsRef.current) {
                transformControlsRef.current.detach();
            }
            if (mountRef.current && mountRef.current.contains(renderer.domElement)) {
                mountRef.current.removeChild(renderer.domElement);
            }
            // Release GPU resources. The scene is rebuilt whenever the depth scale or the
            // selected models change; without forceContextLoss() each rebuild leaves a WebGL
            // context behind, and once the browser's limit (~16) is reached the visible
            // scene loses its context and goes blank.
            transformControls.dispose();
            controls.dispose();
            scene.traverse((obj: any) => {
                obj.geometry?.dispose?.();
                const materials: any[] = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
                for (const m of materials) {
                    for (const value of Object.values(m) as any[]) {
                        if (value?.isTexture) value.dispose();
                    }
                    m.dispose?.();
                }
            });
            renderer.dispose();
            renderer.forceContextLoss();
            sceneRef.current = null;
        };
    }, [imageUrl, depthMapUrl, originalAspectRatio, depthScale, detectedObjects, positionedModels, contextGeneration, applyAlignment, perspective]);

    // Helper function to load image
    const loadImageAsync = (url: string): Promise<HTMLImageElement> => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
    };

    return (
        <div className="w-full min-h-[600px] bg-slate-800 rounded-xl border border-slate-700 relative overflow-hidden shadow-inner">
            <div ref={mountRef} className="w-full h-[600px]" />

            {/* Arrange (Claude) progress */}
            {arrangeLog.length > 0 && (
                <div className="absolute bottom-4 right-4 z-20 w-80 max-h-64 flex flex-col bg-slate-900/95 border border-violet-500/60 rounded-lg shadow-lg text-xs text-slate-200">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
                        <span className="font-semibold text-violet-300">✨ Arrange (Claude)</span>
                        {arranging ? (
                            <button onClick={() => arrangeAbortRef.current?.abort()} className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white">Cancel</button>
                        ) : (
                            <button onClick={() => setArrangeLog([])} className="text-slate-400 hover:text-white" title="Close">×</button>
                        )}
                    </div>
                    <div className="overflow-y-auto px-3 py-2 space-y-1 whitespace-pre-wrap">
                        {arrangeLog.map((m, i) => <p key={i} className={i === arrangeLog.length - 1 ? 'text-slate-100' : 'text-slate-400'}>{m}</p>)}
                    </div>
                </div>
            )}

            {/* Controls Panel */}
            <div className="absolute top-2 right-4 bg-slate-900/95 backdrop-blur px-4 py-3 rounded-lg shadow-md z-20 border border-slate-700">
                {/* Sliders Row */}
                <div className="flex gap-4 mb-3">
                    <div className="flex-1 min-w-[120px]">
                        <label className="block text-xs font-semibold text-slate-300 mb-1">
                            {perspective ? `Depth range: far/near ${(1 + depthScale).toFixed(1)}×` : `Depth: ${depthScale.toFixed(1)}x`}
                        </label>
                        <input
                            type="range"
                            min="0.1"
                            max="5.0"
                            step="0.1"
                            value={depthScale}
                            onChange={(e) => setDepthScale(parseFloat(e.target.value))}
                            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-teal-500"
                        />
                    </div>
                    <div className="flex-1 min-w-[120px]">
                        <label className="block text-xs font-semibold text-slate-300 mb-1">
                            Points: {pointSize.toFixed(1)}
                        </label>
                        <input
                            type="range"
                            min="0.5"
                            max="5.0"
                            step="0.1"
                            value={pointSize}
                            onChange={(e) => setPointSize(parseFloat(e.target.value))}
                            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-teal-500"
                        />
                    </div>
                </div>

                {/* Checkboxes Row - Order: 3D Models, Whole Boxes, Model Boxes, Point Cloud, PC Boxes */}
                <div className="flex gap-4 pt-2 border-t border-slate-700 flex-wrap">
                    {/* 3D Models */}
                    {positionedModels.length > 0 && (
                        <div className="flex items-center gap-1">
                            <input
                                type="checkbox"
                                id="showModels"
                                checked={showModelsToggle}
                                onChange={(e) => {
                                    setShowModelsToggle(e.target.checked);
                                    showModelsRef.current = e.target.checked;
                                    if (sceneRef.current?.modelsGroup) {
                                        sceneRef.current.modelsGroup.visible = e.target.checked;
                                    }
                                }}
                                className="w-3 h-3 text-purple-500 bg-slate-700 border-slate-600 rounded focus:ring-purple-500"
                            />
                            <label htmlFor="showModels" className="text-xs text-slate-300">
                                3D Models ({positionedModels.length})
                            </label>
                        </div>
                    )}
                    {/* Perspective back-projection */}
                    <div className="flex items-center gap-1" title="On: place objects with perspective (real relative sizes; the photo's camera sees the photo). Off: the paper's placement at image size.">
                        <input
                            type="checkbox"
                            id="perspective"
                            checked={perspective}
                            onChange={(e) => setPerspective(e.target.checked)}
                            className="w-3 h-3 text-indigo-500 bg-slate-700 border-slate-600 rounded focus:ring-indigo-500"
                        />
                        <label htmlFor="perspective" className="text-xs text-slate-300">
                            Perspective
                        </label>
                    </div>
                    {/* Front alignment (only when computed) */}
                    {positionedModels.some(m => m.frontAlignment) && (
                        <div className="flex items-center gap-1" title="Turn each model so that its front view matches the completed image it was generated from (the 3D generator may change the viewpoint)">
                            <input
                                type="checkbox"
                                id="applyAlignment"
                                checked={applyAlignment}
                                onChange={(e) => setApplyAlignment(e.target.checked)}
                                className="w-3 h-3 text-indigo-500 bg-slate-700 border-slate-600 rounded focus:ring-indigo-500"
                            />
                            <label htmlFor="applyAlignment" className="text-xs text-slate-300">
                                Align
                            </label>
                        </div>
                    )}
                    {/* Whole Boxes */}
                    {positionedModels.length > 0 && (
                        <div className="flex items-center gap-1">
                            <input
                                type="checkbox"
                                id="showWholeModelBoxes"
                                checked={showWholeModelBoxes}
                                onChange={(e) => {
                                    setShowWholeModelBoxes(e.target.checked);
                                    showWholeModelBoxesRef.current = e.target.checked;
                                    if (sceneRef.current?.wholeModelBoxesGroup) {
                                        sceneRef.current.wholeModelBoxesGroup.visible = e.target.checked;
                                    }
                                }}
                                className="w-3 h-3 text-orange-500 bg-slate-700 border-slate-600 rounded focus:ring-orange-500"
                            />
                            <label htmlFor="showWholeModelBoxes" className="text-xs text-slate-300">
                                Whole Boxes
                            </label>
                        </div>
                    )}
                    {/* Model Boxes */}
                    {positionedModels.length > 0 && (
                        <div className="flex items-center gap-1">
                            <input
                                type="checkbox"
                                id="showModelBoxes"
                                checked={showModelBoxes}
                                onChange={(e) => {
                                    setShowModelBoxes(e.target.checked);
                                    showModelBoxesRef.current = e.target.checked;
                                    if (sceneRef.current?.modelBoxesGroup) {
                                        sceneRef.current.modelBoxesGroup.visible = e.target.checked;
                                    }
                                }}
                                className="w-3 h-3 text-green-500 bg-slate-700 border-slate-600 rounded focus:ring-green-500"
                            />
                            <label htmlFor="showModelBoxes" className="text-xs text-slate-300">
                                Model Boxes
                            </label>
                        </div>
                    )}
                    {/* Point Cloud */}
                    <div className="flex items-center gap-1">
                        <input
                            type="checkbox"
                            id="showPointCloud"
                            checked={showPointCloud}
                            onChange={(e) => {
                                setShowPointCloud(e.target.checked);
                                showPointCloudRef.current = e.target.checked;
                                if (sceneRef.current?.points) {
                                    sceneRef.current.points.visible = e.target.checked;
                                }
                            }}
                            className="w-3 h-3 text-orange-500 bg-slate-700 border-slate-600 rounded focus:ring-orange-500"
                        />
                        <label htmlFor="showPointCloud" className="text-xs text-slate-300">
                            Point Cloud
                        </label>
                    </div>
                    {/* PC Boxes */}
                    {detectedObjects.length > 0 && (
                        <div className="flex items-center gap-1">
                            <input
                                type="checkbox"
                                id="showBoundingBoxes"
                                checked={showBoxes}
                                onChange={(e) => {
                                    setShowBoxes(e.target.checked);
                                    showBoxesRef.current = e.target.checked;
                                    if (sceneRef.current?.boundingBoxGroup) {
                                        sceneRef.current.boundingBoxGroup.visible = e.target.checked;
                                    }
                                }}
                                className="w-3 h-3 text-teal-500 bg-slate-700 border-slate-600 rounded focus:ring-teal-500"
                            />
                            <label htmlFor="showBoundingBoxes" className="text-xs text-slate-300">
                                PC Boxes ({detectedObjects.length})
                            </label>
                        </div>
                    )}
                </div>

                {/* Edit Mode Row - at bottom, Edit toggle on right after Transform */}
                {positionedModels.length > 0 && (
                    <div className="flex gap-2 pt-2 border-t border-slate-700 flex-wrap items-center">
                        {/* Transform buttons only shown in Edit Mode */}
                        {editMode && (
                            <>
                                <span className="text-xs text-slate-400">Transform:</span>
                                <button
                                    onClick={() => setTransformMode('translate')}
                                    className={`px-2 py-1 text-xs rounded ${transformMode === 'translate' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                                >
                                    Move
                                </button>
                                <button
                                    onClick={() => setTransformMode('rotate')}
                                    className={`px-2 py-1 text-xs rounded ${transformMode === 'rotate' ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                                >
                                    Rotate
                                </button>
                                <button
                                    onClick={() => setTransformMode('scale')}
                                    className={`px-2 py-1 text-xs rounded ${transformMode === 'scale' ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                                >
                                    Scale
                                </button>
                                <button
                                    onClick={() => undoRef.current()}
                                    disabled={historySize.undo === 0}
                                    className="px-2 py-1 text-xs rounded bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
                                    title="Undo the last move, rotation, scale or reset (Ctrl+Z)"
                                >
                                    ↶ Undo
                                </button>
                                <button
                                    onClick={() => redoRef.current()}
                                    disabled={historySize.redo === 0}
                                    className="px-2 py-1 text-xs rounded bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
                                    title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
                                >
                                    ↷ Redo
                                </button>
                                {transformMode === 'scale' && (
                                    <label
                                        className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer"
                                        title="On: any scale handle scales all axes by the same factor (keeps the proportions). Off: each handle scales only its own axis."
                                    >
                                        <input
                                            type="checkbox"
                                            checked={uniformScale}
                                            onChange={(e) => setUniformScale(e.target.checked)}
                                            className="w-3 h-3 rounded border-slate-600 text-purple-500 bg-slate-700"
                                        />
                                        Uniform
                                    </label>
                                )}
                                <span className="text-slate-600">|</span>
                            </>
                        )}
                        {/* Deselect button */}
                        {selectedModelIndex >= 0 && (
                            <button
                                onClick={() => {
                                    if (transformControlsRef.current) {
                                        transformControlsRef.current.detach();
                                        // Reset all whole box colors to orange
                                        wholeBoxContainersRef.current.forEach((wholeBox) => {
                                            if (wholeBox && wholeBox.children[0]) {
                                                const lineSegments = wholeBox.children[0] as THREE.LineSegments;
                                                if (lineSegments.material) {
                                                    const mat = lineSegments.material as THREE.LineBasicMaterial;
                                                    mat.color.setHex(0xf97316);
                                                }
                                            }
                                        });
                                        setSelectedModelIndex(-1);
                                    }
                                }}
                                className="px-2 py-1 text-xs rounded bg-red-600 text-white hover:bg-red-500"
                            >
                                Deselect
                            </button>
                        )}
                        {/* Reset button - restore selected model to original position */}
                        {selectedModelIndex >= 0 && meshContainersRef.current[selectedModelIndex]?.userData.autoTransform && (
                            <button
                                onClick={() => {
                                    const meshContainer = meshContainersRef.current[selectedModelIndex];
                                    if (!meshContainer) return;
                                    const modelId = meshContainer.userData.modelId as string;
                                    const before = layoutRef.current.get(modelId);
                                    applyTransform(meshContainer, meshContainer.userData.autoTransform);
                                    layoutRef.current.delete(modelId);
                                    if (before) pushStepRef.current({ modelId, before, after: undefined });
                                    reportLayoutRef.current();
                                }}
                                className="px-2 py-1 text-xs rounded bg-orange-600 text-white hover:bg-orange-500"
                                title="Back to the automatic placement"
                            >
                                ↩️ Reset
                            </button>
                        )}
                        {/* Save/Load buttons */}
                        <button
                            onClick={handleSaveScene}
                            className="px-2 py-1 text-xs rounded bg-cyan-600 text-white hover:bg-cyan-500"
                            title="Save the scene layout (where each model is, the settings and the camera) as a small JSON file. The models are not included: load the layout into the same project."
                        >
                            💾 Save
                        </button>
                        <button
                            onClick={handleLoadScene}
                            className="px-2 py-1 text-xs rounded bg-cyan-600 text-white hover:bg-cyan-500"
                            title="Load a scene layout (JSON) saved with Save, or a GLB exported with GLB"
                        >
                            📂 Load
                        </button>
                        <button
                            onClick={handleExportGlb}
                            className="px-2 py-1 text-xs rounded bg-slate-600 text-slate-200 hover:bg-slate-500"
                            title="Export the models as placed as one GLB file, for other 3D software (large: it contains every model)"
                        >
                            GLB
                        </button>
                        <button
                            onClick={handleArrange}
                            disabled={arranging || !perspective}
                            className="px-2 py-1 text-xs rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            title={perspective
                                ? 'Arrange the models with Claude (Anthropic API) so that the scene matches the photo: objects on the table, people on their chairs, plausible sizes and orientations. Uses several API calls with images. The result can be undone (Undo in edit mode).'
                                : 'Arrange needs Perspective on'}
                        >
                            {arranging ? '✨ Arranging…' : '✨ Arrange'}
                        </button>
                        {/* Edit Mode Toggle - on right */}
                        <button
                            onClick={() => setEditMode(!editMode)}
                            className={`px-2 py-1 text-xs rounded ml-auto ${editMode ? 'bg-yellow-500 text-black font-semibold' : 'bg-slate-600 text-slate-300 hover:bg-slate-500'}`}
                            title={editMode ? "Edit Mode ON - click empty space won't deselect" : "Edit Mode OFF - click empty space to deselect"}
                        >
                            {editMode ? '✏️ Edit ON' : '✏️ Edit OFF'}
                        </button>
                    </div>
                )}
            </div>

            {loading && (
                <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center flex-col z-10">
                    <Spinner />
                    <p className="mt-4 text-slate-300 font-medium">Generating Point Cloud...</p>
                </div>
            )}

            {showInfo ? (
            <div className="absolute bottom-4 left-4 bg-slate-900/90 backdrop-blur px-3 py-2 rounded-lg text-xs text-slate-400 shadow-sm border border-slate-700">
                <div className="flex items-start justify-between gap-3 mb-1">
                    <p className="font-bold text-slate-300">Depth-Only 3D Scene</p>
                    <button
                        onClick={() => setShowInfo(false)}
                        className="text-slate-400 hover:text-white leading-none -mt-0.5"
                        title="Hide this panel"
                        aria-label="Hide the info panel"
                    >
                        ×
                    </button>
                </div>
                <p>• Resolution: 256 × {Math.round(256 / originalAspectRatio)} points</p>
                <p>• Drag to rotate, scroll to zoom</p>
                {detectedObjects.length > 0 && (
                    <p>• {detectedObjects.length} bounding box{detectedObjects.length !== 1 ? 'es' : ''}</p>
                )}
            </div>
            ) : (
                <button
                    onClick={() => setShowInfo(true)}
                    className="absolute bottom-4 left-4 w-7 h-7 rounded-full bg-slate-900/80 text-slate-300 hover:text-white text-xs font-bold border border-slate-700 shadow-sm"
                    title="Show the info panel"
                    aria-label="Show the info panel"
                >
                    i
                </button>
            )}
        </div>
    );
};
