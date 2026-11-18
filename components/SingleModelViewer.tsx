import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Model3D } from '../types';
import { Spinner } from './Spinner';
import { calculateTightBoundingBox } from '../utils';

interface SingleModelViewerProps {
    model: Model3D;
    showBoundingBox?: boolean;
}

export const SingleModelViewer: React.FC<SingleModelViewerProps> = ({ model, showBoundingBox = false }) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = useState(false);
    const [isVisible, setIsVisible] = useState(false);
    const helpersGroupRef = useRef<THREE.Group | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const frameIdRef = useRef<number>(0);

    // Toggle Effect
    useEffect(() => {
        if (helpersGroupRef.current) {
            helpersGroupRef.current.visible = showBoundingBox;
        }
    }, [showBoundingBox]);

    // Intersection Observer to handle WebGL Context Limit
    useEffect(() => {
        if (!mountRef.current) return;

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                setIsVisible(entry.isIntersecting);
            }
        }, { rootMargin: '200px' });

        observer.observe(mountRef.current);

        return () => {
            observer.disconnect();
        };
    }, []);

    // Scene & Renderer Management
    useEffect(() => {
        if (!isVisible || !mountRef.current) {
            if (rendererRef.current) {
                if (mountRef.current.contains(rendererRef.current.domElement)) {
                    mountRef.current.removeChild(rendererRef.current.domElement);
                }
                rendererRef.current.dispose();
                rendererRef.current.forceContextLoss();
                rendererRef.current = null;
            }
            if (frameIdRef.current) {
                cancelAnimationFrame(frameIdRef.current);
                frameIdRef.current = 0;
            }
            return;
        }

        setLoading(true);

        mountRef.current.innerHTML = '';

        const scene = new THREE.Scene();
        sceneRef.current = scene;
        scene.background = new THREE.Color(0xf8fafc); // Slate-50

        // Camera
        const camera = new THREE.PerspectiveCamera(45, mountRef.current.clientWidth / mountRef.current.clientHeight, 0.1, 100);
        camera.position.set(0, 1, 2.5);

        // Renderer with proper color management for TRELLIS.2 textures
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        rendererRef.current = renderer;
        renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
        controls.autoRotate = true;
        controls.autoRotateSpeed = 2.0;
        controls.target.set(0, 0.5, 0);

        // Lights - Enhanced for brighter textures
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
        scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
        dirLight.position.set(2, 5, 5);
        dirLight.castShadow = true;
        scene.add(dirLight);

        const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
        fillLight.position.set(-2, 2, -2);
        scene.add(fillLight);

        const backFillLight = new THREE.DirectionalLight(0xffffff, 0.4);
        backFillLight.position.set(0, 3, -5);
        scene.add(backFillLight);

        // Ground Plane
        const planeGeometry = new THREE.PlaneGeometry(10, 10);
        const planeMaterial = new THREE.ShadowMaterial({ opacity: 0.1, color: 0x000000 });
        const plane = new THREE.Mesh(planeGeometry, planeMaterial);
        plane.rotation.x = -Math.PI / 2;
        plane.receiveShadow = true;
        scene.add(plane);

        const modelGroup = new THREE.Group();
        scene.add(modelGroup);

        const helpersGroup = new THREE.Group();
        scene.add(helpersGroup);
        helpersGroup.visible = showBoundingBox;
        helpersGroupRef.current = helpersGroup;

        // Load Model
        const loader = new GLTFLoader();
        let isAborted = false;

        loader.load(
            model.glbUrl,
            (gltf) => {
                if (isAborted || !rendererRef.current) return;

                const mesh = gltf.scene;
                const box = new THREE.Box3().setFromObject(mesh);
                const size = new THREE.Vector3();
                box.getSize(size);
                const center = new THREE.Vector3();
                box.getCenter(center);

                const maxDim = Math.max(size.x, size.y, size.z);
                const scale = 1.0 / maxDim;
                mesh.scale.set(scale, scale, scale);
                mesh.position.sub(center.multiplyScalar(scale));
                mesh.position.y += (size.y * scale) / 2;
                // Apply rotation based on provider - TRELLIS.2 models don't need rotation
                if (model.provider !== 'trellis') {
                    mesh.rotation.y = Math.PI; // Face the camera for other providers
                }

                mesh.traverse((node) => {
                    if ((node as THREE.Mesh).isMesh) {
                        const meshNode = node as THREE.Mesh;
                        meshNode.castShadow = true;
                        meshNode.receiveShadow = true;

                        // Fix texture color space for proper color rendering
                        // Handle both single material and material array
                        const materials = Array.isArray(meshNode.material)
                            ? meshNode.material
                            : [meshNode.material];

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

                            // Brightness boost for TRELLIS.2 models (they tend to be dark)
                            if (model.provider === 'trellis') {
                                // Increase base color brightness
                                if (material.color) {
                                    material.color.multiplyScalar(1.5);
                                }
                                // Reduce roughness for more reflective surface
                                if (material.roughness !== undefined) {
                                    material.roughness = Math.max(0.3, material.roughness * 0.7);
                                }
                            }

                            // Force material update
                            material.needsUpdate = true;
                        });
                    }
                });

                modelGroup.add(mesh);

                const finalBox = new THREE.Box3().setFromObject(mesh);
                const finalSize = new THREE.Vector3();
                finalBox.getSize(finalSize);
                const finalWidth = finalSize.x;
                const finalHeight = finalSize.y;
                const finalDepth = finalSize.z;
                const finalCenter = new THREE.Vector3();
                finalBox.getCenter(finalCenter);

                // A. Purple Box (Full Object)
                const boxGeo = new THREE.BoxGeometry(finalWidth, finalHeight, finalDepth);
                const edges = new THREE.EdgesGeometry(boxGeo);
                const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xa855f7 }));
                line.position.copy(finalCenter);
                helpersGroup.add(line);

                // B. Green Box Logic
                const drawGreenBox = (tightBox: [number, number, number, number]) => {
                    if (!model.originalPartBox2d) return;

                    const [tymin, txmin, tymax, txmax] = tightBox;
                    const [gymin, gxmin, gymax, gxmax] = model.originalPartBox2d;

                    const meshGlobalWidth = txmax - txmin;
                    const meshGlobalHeight = tymax - tymin;

                    if (meshGlobalWidth <= 1e-5 || meshGlobalHeight <= 1e-5) return;

                    // Relative position of Green Box inside Mesh Box
                    const relXMin = (gxmin - txmin) / meshGlobalWidth;
                    const relXMax = (gxmax - txmin) / meshGlobalWidth;

                    // In 2D, Top is 0. 
                    // In 3D, Top is MaxY.
                    // We need relative offset from Top.
                    const relYMeanTop = (gymin - tymin) / meshGlobalHeight;
                    const relYMeanBottom = (gymax - tymin) / meshGlobalHeight;

                    const gMaxY = finalBox.max.y - (finalHeight * relYMeanTop);
                    const gMinY = finalBox.max.y - (finalHeight * relYMeanBottom);

                    const gMinX = finalBox.min.x + (finalWidth * relXMin);
                    const gMaxX = finalBox.min.x + (finalWidth * relXMax);

                    const gWidth = gMaxX - gMinX;
                    const gHeight = gMaxY - gMinY;
                    const gDepth = finalDepth * 1.01;

                    if (gWidth <= 0 || gHeight <= 0) return;

                    const greenGeo = new THREE.BoxGeometry(gWidth, gHeight, gDepth);
                    const greenEdges = new THREE.EdgesGeometry(greenGeo);
                    const greenLine = new THREE.LineSegments(greenEdges, new THREE.LineBasicMaterial({ color: 0x22c55e }));

                    greenLine.position.set(
                        gMinX + gWidth / 2,
                        gMinY + gHeight / 2,
                        finalCenter.z
                    );
                    helpersGroup.add(greenLine);
                };

                if (model.tightBox2d) {
                    drawGreenBox(model.tightBox2d);
                } else {
                    // Fallback: If tightBox2d is missing, try to calculate it from the poster image (which is the source)
                    // This handles legacy models without metadata.
                    calculateTightBoundingBox(model.posterUrl).then((calculatedTightBox) => {
                        if (calculatedTightBox && !isAborted && rendererRef.current) {
                            drawGreenBox(calculatedTightBox);
                        } else {
                            // Final Fallback: Assume Mesh = Whole Image
                            drawGreenBox([0, 0, 1, 1]);
                        }
                    }).catch(e => {
                        console.warn("Failed to calculate fallback tightBox in 3D viewer", e);
                        drawGreenBox([0, 0, 1, 1]);
                    });
                }

                setLoading(false);
            },
            undefined,
            (err) => {
                if (!isAborted) {
                    console.error("Failed to load model", err);
                    setLoading(false);
                }
            }
        );

        const handleResize = () => {
            if (!mountRef.current || !rendererRef.current) return;
            const width = mountRef.current.clientWidth;
            const height = mountRef.current.clientHeight;
            rendererRef.current.setSize(width, height);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        };
        window.addEventListener('resize', handleResize);

        const animate = () => {
            frameIdRef.current = requestAnimationFrame(animate);
            controls.update();
            if (rendererRef.current && sceneRef.current) {
                rendererRef.current.render(sceneRef.current, camera);
            }
        };
        animate();

        return () => {
            isAborted = true;
            window.removeEventListener('resize', handleResize);
            if (frameIdRef.current) cancelAnimationFrame(frameIdRef.current);
            if (rendererRef.current) {
                if (mountRef.current && mountRef.current.contains(rendererRef.current.domElement)) {
                    mountRef.current.removeChild(rendererRef.current.domElement);
                }
                rendererRef.current.dispose();
                rendererRef.current.forceContextLoss();
                rendererRef.current = null;
            }
            helpersGroupRef.current = null;
        };
    }, [model.glbUrl, isVisible, model.originalPartBox2d, model.tightBox2d]);

    return (
        <div className="w-full h-full relative" ref={mountRef}>
            {(!isVisible || loading) && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-50/80 backdrop-blur-sm z-10 transition-opacity duration-300">
                    {model.posterUrl && !isVisible ? (
                        <div className="w-full h-full p-8 flex items-center justify-center opacity-40 grayscale">
                            <img src={model.posterUrl} className="max-w-full max-h-full object-contain" alt="preview" />
                        </div>
                    ) : (
                        loading && <Spinner />
                    )}
                </div>
            )}
        </div>
    );
};
