import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Spinner } from './Spinner';
import { DetectedObject, Model3D } from '../types';
import { Box2D, DepthRange, ObjectMask, loadObjectMask, medianDepthInBox, sameBox } from './depthSampling';

/**
 * Alpha masks for Eq. (4): the background-removed image of each model.
 * A completed image is larger than the original crop; `originalPartBox2d`
 * (found by AKAZE) tells which part of it matches the object's box in the scene.
 * Without that alignment the mask cannot be placed, so none is used.
 */
const loadModelMasks = async (models: Model3D[]): Promise<Map<string, ObjectMask>> => {
    const masks = new Map<string, ObjectMask>();
    await Promise.all(models.map(async (model) => {
        const region: Box2D | null = model.originalPartBox2d
            ?? (model.completionExpansionRatio === undefined ? [0, 0, 1, 1] : null);
        if (!region || !model.posterUrl) return;
        try {
            masks.set(model.id, await loadObjectMask(model.posterUrl, region));
        } catch (e) {
            console.warn(`Failed to load mask for ${model.label}; using all pixels in the box`, e);
        }
    }));
    return masks;
};

interface DepthOnlySceneProps {
    imageUrl: string;
    depthMapUrl: string;
    originalAspectRatio?: number;
    detectedObjects?: DetectedObject[];
    positionedModels?: Model3D[];
    showModels?: boolean;
}

export const DepthOnlyScene: React.FC<DepthOnlySceneProps> = ({
    imageUrl,
    depthMapUrl,
    originalAspectRatio = 1,
    detectedObjects = [],
    positionedModels = [],
    showModels = true
}) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = useState(true);
    const [depthScale, setDepthScale] = useState(0.5);
    const [pointSize, setPointSize] = useState(2.0);
    const [showBoxes, setShowBoxes] = useState(false); // PC Boxes off by default
    const [showPointCloud, setShowPointCloud] = useState(false);
    const [showModelsToggle, setShowModelsToggle] = useState(showModels);
    const [showModelBoxes, setShowModelBoxes] = useState(false); // Model Boxes off by default
    const [showWholeModelBoxes, setShowWholeModelBoxes] = useState(false); // Whole Boxes off by default
    const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
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
    // Store original transforms for reset functionality
    const originalTransformsRef = useRef<Map<number, { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }>>(new Map());

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

    // Save scene to glTF/GLB file
    const handleSaveScene = () => {
        if (!sceneRef.current?.modelsGroup) return;

        const exporter = new GLTFExporter();
        exporter.parse(
            sceneRef.current.modelsGroup,
            (result) => {
                const blob = new Blob([result as ArrayBuffer], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'scene.glb';
                link.click();
                URL.revokeObjectURL(url);
            },
            (error) => {
                console.error('Error exporting scene:', error);
            },
            { binary: true }
        );
    };

    // Load scene from glTF/GLB file
    const handleLoadScene = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.glb,.gltf';
        input.onchange = (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file || !sceneRef.current?.modelsGroup) return;

            const reader = new FileReader();
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
                // Dragging ended - keep isDraggingRef true for a short time to block click events
                setTimeout(() => {
                    isDraggingRef.current = false;
                }, 200);
            }
        });
        // Use getHelper() to get the gizmo object that can be added to scene
        // This fixes the issue with multiple Three.js instances
        const transformHelper = transformControls.getHelper();
        scene.add(transformHelper);
        transformControlsRef.current = transformControls;

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

                const depthMin = 0.5;
                const depthMax = 5.0;
                const aspectCorrection = originalAspectRatio;

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const idx = (y * width + x) * 4;

                        // Get depth value (grayscale - use R channel)
                        const depthValue = depthData.data[idx];
                        // Invert: white (255) = close, black (0) = far
                        const normalizedDepth = 1.0 - (depthValue / 255.0);
                        const z = -(depthMin + normalizedDepth * (depthMax - depthMin)) * depthScale;

                        // Calculate X and Y from pixel position
                        // Center the point cloud
                        const xPos = ((x / width) - 0.5) * 2 * aspectCorrection;
                        const yPos = -((y / height) - 0.5) * 2; // Flip Y

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

                // Alpha masks of the models' background-removed images (Eq. (4))
                const depthRange: DepthRange = { min: depthMin, max: depthMax };
                const masks = await loadModelMasks(positionedModels);
                if (disposed) return;

                // Create PC Boxes for detected objects
                createBoundingBoxes(depthData, depthRange, aspectCorrection, masks);

                // Load 3D models and position them
                loadModels(depthData, depthRange, aspectCorrection, masks);

                // Adjust camera to view the point cloud
                const box = new THREE.Box3().setFromObject(points);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);

                camera.position.set(center.x, center.y, center.z + maxDim * 1.5);
                controls.target.copy(center);
                controls.update();

                setLoading(false);
            } catch (error) {
                console.error('Failed to load point cloud:', error);
                setLoading(false);
            }
        };

        const createBoundingBoxes = (
            depthData: ImageData,
            depthRange: DepthRange,
            aspectCorrection: number,
            masks: Map<string, ObjectMask>
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
                const medianDepth = medianDepthInBox(depthData, obj.box_2d, depthRange, model ? masks.get(model.id) : null).z;
                const zPos = -medianDepth * depthScale;

                // Calculate 3D position and size
                const x3dMin = ((xmin) - 0.5) * 2 * aspectCorrection;
                const x3dMax = ((xmax) - 0.5) * 2 * aspectCorrection;
                const y3dMin = -((ymax) - 0.5) * 2; // Flip Y
                const y3dMax = -((ymin) - 0.5) * 2; // Flip Y

                const boxWidth = x3dMax - x3dMin;
                const boxHeight = y3dMax - y3dMin;
                const boxDepth = 0.1 * depthScale; // Thin depth for visibility

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
            aspectCorrection: number,
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
                const zPos = -medianDepth * depthScale;

                // Calculate 3D position (same as bounding boxes)
                const x3dMin = ((ds_xmin) - 0.5) * 2 * aspectCorrection;
                const x3dMax = ((ds_xmax) - 0.5) * 2 * aspectCorrection;
                const y3dMin = -((ds_ymax) - 0.5) * 2;
                const y3dMax = -((ds_ymin) - 0.5) * 2;

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
                    const centeredBox = new THREE.Box3().setFromObject(mesh);
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
                        // Save original transform if not already saved
                        if (!originalTransformsRef.current.has(modelIndex)) {
                            originalTransformsRef.current.set(modelIndex, {
                                position: meshContainer.position.clone(),
                                rotation: meshContainer.rotation.clone(),
                                scale: meshContainer.scale.clone()
                            });
                        }
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

        // Resize handler
        const handleResize = () => {
            if (!mountRef.current) return;
            const width = mountRef.current.clientWidth;
            const height = mountRef.current.clientHeight;
            renderer.setSize(width, height);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        };
        window.addEventListener('resize', handleResize);

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
    }, [imageUrl, depthMapUrl, originalAspectRatio, depthScale, detectedObjects, positionedModels]);

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

            {/* Controls Panel */}
            <div className="absolute top-2 right-4 bg-slate-900/95 backdrop-blur px-4 py-3 rounded-lg shadow-md z-20 border border-slate-700">
                {/* Sliders Row */}
                <div className="flex gap-4 mb-3">
                    <div className="flex-1 min-w-[120px]">
                        <label className="block text-xs font-semibold text-slate-300 mb-1">
                            Depth: {depthScale.toFixed(1)}x
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
                        {selectedModelIndex >= 0 && originalTransformsRef.current.has(selectedModelIndex) && (
                            <button
                                onClick={() => {
                                    const meshContainer = meshContainersRef.current[selectedModelIndex];
                                    const original = originalTransformsRef.current.get(selectedModelIndex);
                                    if (meshContainer && original) {
                                        meshContainer.position.copy(original.position);
                                        meshContainer.rotation.copy(original.rotation);
                                        meshContainer.scale.copy(original.scale);
                                    }
                                }}
                                className="px-2 py-1 text-xs rounded bg-orange-600 text-white hover:bg-orange-500"
                                title="Reset to original position/rotation/scale"
                            >
                                ↩️ Reset
                            </button>
                        )}
                        {/* Save/Load buttons */}
                        <button
                            onClick={handleSaveScene}
                            className="px-2 py-1 text-xs rounded bg-cyan-600 text-white hover:bg-cyan-500"
                            title="Save scene as GLB file (CAD compatible)"
                        >
                            💾 Save
                        </button>
                        <button
                            onClick={handleLoadScene}
                            className="px-2 py-1 text-xs rounded bg-cyan-600 text-white hover:bg-cyan-500"
                            title="Load scene from GLB file"
                        >
                            📂 Load
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

            <div className="absolute bottom-4 left-4 bg-slate-900/90 backdrop-blur px-3 py-2 rounded-lg text-xs text-slate-400 shadow-sm pointer-events-none border border-slate-700">
                <p className="font-bold mb-1 text-slate-300">Depth-Only 3D Scene</p>
                <p>• Resolution: 256 × {Math.round(256 / originalAspectRatio)} points</p>
                <p>• Drag to rotate, scroll to zoom</p>
                {detectedObjects.length > 0 && (
                    <p>• {detectedObjects.length} bounding box{detectedObjects.length !== 1 ? 'es' : ''}</p>
                )}
            </div>
        </div>
    );
};
