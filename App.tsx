import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ImageUploader } from './components/ImageUploader';
import { Spinner } from './components/Spinner';
import { ResultCard } from './components/ResultCard';
import { Model3DCard } from './components/Model3DCard';

import { DepthOnlyScene } from './components/DepthOnlyScene';
import { BoundingBoxOverlay } from './components/BoundingBoxOverlay';
import { detectObjectsInImage, generateCompletion, estimateCanvasExpansion, verifyCompletion } from './services/aiService';
import { loadAISettings, saveAISettings, hasRequiredKeys, PROVIDER_LABELS } from './services/ai/models';
import { AISettingsDialog } from './components/AISettingsDialog';
import { cropObjectsFromImage, removeBackgroundWithRembg, findBestMatchPosition, generate3DModelWithHunyuan3D, generate3DModelWithTrellis, blobUrlToDataUrl, dataUrlToBlobUrl, generateDepthMap, prepareImageForCompletion, calculateTightBoundingBox } from './utils';
import { DetectedObject, CroppedObject, Model3D, ModelProvider, ProjectArchive, AISettings } from './types';
import { Scan, Sparkles, AlertCircle, Layers, Image as ImageIcon, User, Box, ArrowLeft, Upload, Plug, Wand2, RefreshCw, Star, Download, MonitorPlay, Cuboid, Save, FolderOpen, Trash2 } from 'lucide-react';

type AppMode = 'landing' | 'analyze' | 'batch-remove' | 'complete-body' | 'generate-3d';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('landing');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Name of the analyzed photo (without extension), used for saved file names
  const [sourceImageName, setSourceImageName] = useState<string | null>(null);
  const [originalImageDimensions, setOriginalImageDimensions] = useState<{ width: number, height: number } | null>(null);

  // AI provider settings (API keys, providers, model IDs)
  const [aiSettings, setAISettings] = useState<AISettings>(() => loadAISettings());
  const [showAISettings, setShowAISettings] = useState(false);
  const hasAIKeys = hasRequiredKeys(aiSettings);
  useEffect(() => { saveAISettings(aiSettings); }, [aiSettings]);

  // Analysis states
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [detectedObjects, setDetectedObjects] = useState<DetectedObject[]>([]);
  const [croppedImages, setCroppedImages] = useState<CroppedObject[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Depth Map State
  const [depthMapUrl, setDepthMapUrl] = useState<string | null>(null);
  const [isGeneratingDepth, setIsGeneratingDepth] = useState(false);

  // 3D generation settings
  const [modelProvider, setModelProvider] = useState<ModelProvider>('trellis');
  const [hfToken, setHfToken] = useState(import.meta.env.VITE_HF_TOKEN || '');

  // Overlap refinement state


  // Track processing IDs to prevent duplicates (useState to trigger re-renders)
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  // Image Completion states
  const [completedImages, setCompletedImages] = useState<CroppedObject[]>([]);
  const [completionOriginalUrl, setCompletionOriginalUrl] = useState<string | null>(null);
  const [completionResult, setCompletionResult] = useState<CroppedObject | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isBatchCompleting, setIsBatchCompleting] = useState(false);
  const [completionTarget, setCompletionTarget] = useState<'person' | 'object'>('person');
  const [bgRemovalAfterCompletion, setBgRemovalAfterCompletion] = useState(true); // Default: ON, uses RMBG

  // 3D Generation states
  const [models3D, setModels3D] = useState<Model3D[]>([]);
  const [model3DSource, setModel3DSource] = useState<CroppedObject | null>(null);
  const [isGenerating3DGlobal, setIsGenerating3DGlobal] = useState(false);
  const [isBatchGenerating3D, setIsBatchGenerating3D] = useState(false);

  // Processing time tracking
  const [processingTimes, setProcessingTimes] = useState<Map<string, number>>(new Map());

  // Project Archiving State
  const [isArchiving, setIsArchiving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // UI states
  const [activeTab, setActiveTab] = useState<'original' | 'completed' | '3d' | 'scene'>('original');
  const [filter, setFilter] = useState<'all' | 'person'>('all');

  // Selection State - Per-tab selection to preserve selections when switching tabs
  const [selectedItemsPerTab, setSelectedItemsPerTab] = useState<{
    original: Set<string>;
    completed: Set<string>;
    '3d': Set<string>;
    scene: Set<string>;
  }>({
    original: new Set(),
    completed: new Set(),
    '3d': new Set(),
    scene: new Set(),
  });

  // Get current tab's selection
  const selectedItems = selectedItemsPerTab[activeTab];

  // Helper to update selection for current tab
  const setSelectedItems = (newSelected: Set<string>) => {
    setSelectedItemsPerTab(prev => ({
      ...prev,
      [activeTab]: newSelected,
    }));
  };

  // Helper to add new items to selection for a specific tab
  const addToSelection = (tab: 'original' | 'completed' | '3d' | 'scene', ids: string[]) => {
    setSelectedItemsPerTab(prev => {
      const newSet = new Set(prev[tab]);
      ids.forEach(id => newSet.add(id));
      // For 3d tab, also update scene tab
      if (tab === '3d') {
        const sceneSet = new Set(prev.scene);
        ids.forEach(id => sceneSet.add(id));
        return { ...prev, [tab]: newSet, scene: sceneSet };
      }
      return { ...prev, [tab]: newSet };
    });
  };

  // Bounding Box Display State  
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(false);

  // Delete Confirmation State
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Filter the lists based on the selected filter
  const filteredCroppedImages = useMemo(() => croppedImages.filter(item =>
    filter === 'all' ? true : item.type === 'person'
  ), [croppedImages, filter]);



  const filteredCompletedImages = useMemo(() => completedImages.filter(item =>
    filter === 'all' ? true : item.type === 'person'
  ), [completedImages, filter]);

  const positionedModels = useMemo(() => models3D.filter(m => m.box_2d && selectedItemsPerTab['3d'].has(m.id)), [models3D, selectedItemsPerTab]);

  // Initialize selection for each tab only when data changes (not on every tab switch)
  // This preserves selection when switching between tabs
  // Track previous IDs for Extracted tab to handle "default selected" behavior for new items
  const prevCroppedIdsRef = useRef<Set<string>>(new Set());

  // Initialize selection for each tab only when data changes (not on every tab switch)
  // This preserves selection when switching between tabs
  useEffect(() => {
    const currentIds = new Set(filteredCroppedImages.map(i => i.id));
    const prevIds = prevCroppedIdsRef.current;

    // Identify items that are NEW to the list (compared to last render)
    // This ensures that newly analyzed or uploaded images are selected by default,
    // while preserving the selection state of existing items.
    const newIds = filteredCroppedImages
      .filter(item => !prevIds.has(item.id))
      .map(item => item.id);

    if (newIds.length > 0) {
      setSelectedItemsPerTab(prev => {
        const newSet = new Set(prev.original);
        newIds.forEach(id => newSet.add(id));
        return { ...prev, original: newSet };
      });
    }

    // Update ref for next comparison
    prevCroppedIdsRef.current = currentIds;
  }, [filteredCroppedImages]);



  useEffect(() => {
    setSelectedItemsPerTab(prev => {
      const hasValidSelection = Array.from(prev.completed).some(id =>
        filteredCompletedImages.some(item => item.id === id)
      );
      if (hasValidSelection || filteredCompletedImages.length === 0) return prev;
      return { ...prev, completed: new Set(filteredCompletedImages.map(i => i.id)) };
    });
  }, [filteredCompletedImages]);

  useEffect(() => {
    setSelectedItemsPerTab(prev => {
      const hasValidSelection = Array.from(prev['3d']).some(id =>
        models3D.some(item => item.id === id)
      );
      if (hasValidSelection || models3D.length === 0) return prev;
      const newSelection = new Set(models3D.map(i => i.id));
      return { ...prev, '3d': newSelection, scene: newSelection };
    });
  }, [models3D]);

  const handleSelect = (id: string, selected: boolean) => {
    const newSelected = new Set<string>(selectedItems);
    if (selected) {
      newSelected.add(id);
    } else {
      newSelected.delete(id);
    }
    // Sync 3d and scene tab selections
    if (activeTab === '3d') {
      setSelectedItemsPerTab(prev => ({
        ...prev,
        '3d': newSelected,
        scene: newSelected,
      }));
    } else {
      setSelectedItems(newSelected);
    }
  };

  const handleSelectAll = () => {
    let items: { id: string }[] = [];
    if (activeTab === 'original') items = filteredCroppedImages;

    else if (activeTab === 'completed') items = filteredCompletedImages;
    else if (activeTab === '3d') items = models3D;

    const newSelected = new Set(items.map(i => i.id));
    // Sync 3d and scene tab selections
    if (activeTab === '3d') {
      setSelectedItemsPerTab(prev => ({
        ...prev,
        '3d': newSelected,
        scene: newSelected,
      }));
    } else {
      setSelectedItems(newSelected);
    }
  };

  const handleDeselectAll = () => {
    // Sync 3d and scene tab selections
    if (activeTab === '3d') {
      setSelectedItemsPerTab(prev => ({
        ...prev,
        '3d': new Set(),
        scene: new Set(),
      }));
    } else {
      setSelectedItems(new Set());
    }
  };

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (completionOriginalUrl) URL.revokeObjectURL(completionOriginalUrl);
    };
  }, [previewUrl, completionOriginalUrl]);

  const openAISettings = () => setShowAISettings(true);

  const handleAnalysisImageSelected = async (files: File[]) => {
    const file = files[0];
    if (!file) return;

    if (!hasAIKeys) {
      openAISettings();
      return;
    }

    setMode('analyze');
    setSourceImageName(file.name.replace(/\.[^/.]+$/, ''));

    // Convert to Data URL for persistence
    const reader = new FileReader();
    reader.onload = (e) => {
      const url = e.target?.result as string;
      setPreviewUrl(url);

      const img = new Image();
      img.onload = () => {
        setOriginalImageDimensions({ width: img.width, height: img.height });
      };
      img.src = url;

      // Trigger analysis after loading
      startAnalysis(file, url);
    };
    reader.readAsDataURL(file);

    setDetectedObjects([]);
    setCroppedImages([]);

    setCompletedImages([]);
    setModels3D([]);
    setDepthMapUrl(null);
    setError(null);

    setIsAnalyzing(true);
    setActiveTab('original');
    setFilter('all');
  };

  const startAnalysis = async (file: File, url: string) => {
    const t0 = performance.now();
    try {
      const objects = await detectObjectsInImage(file, aiSettings);
      setDetectedObjects(objects);

      if (objects.length === 0) {
        setError("No objects were detected in this image. Try a clearer image.");
        setIsAnalyzing(false);
        return;
      }

      const crops = await cropObjectsFromImage(url, objects);
      setCroppedImages(crops);

    } catch (err) {
      console.error(err);
      setError(`Failed to analyze image: ${err instanceof Error ? err.message : String(err)}. Check the API key and model in AI Settings.`);
    } finally {
      const elapsed = (performance.now() - t0) / 1000;
      setProcessingTimes(prev => new Map(prev).set('Object Detection', elapsed));
      setIsAnalyzing(false);
    }
  };

  const handleGenerateDepthMap = async () => {
    if (!previewUrl) return;

    // Skip if depth map already exists
    if (depthMapUrl) {
      setActiveTab('scene');
      return;
    }

    setActiveTab('scene');
    setIsGeneratingDepth(true);
    const t0 = performance.now();
    try {
      const depthUrl = await generateDepthMap(previewUrl, hfToken, aiSettings.spaces.depth);
      setDepthMapUrl(depthUrl);
    } catch (e: any) {
      console.error("Depth map generation failed", e);
      alert("Failed to generate depth map: " + e.message);
    } finally {
      const elapsed = (performance.now() - t0) / 1000;
      setProcessingTimes(prev => new Map(prev).set('Depth Map', elapsed));
      setIsGeneratingDepth(false);
    }
  };



  const handleGenerate3D = async (item: CroppedObject) => {
    setActiveTab('3d');

    // Check if already processed or processing
    if (models3D.some(m => m.posterUrl === item.imageUrl) || processingIds.has(item.id)) {
      return;
    }

    setProcessingIds(prev => new Set(prev).add(item.id));
    const t0 = performance.now();

    setIsGenerating3DGlobal(true);
    try {
      let glbBlob: Blob;

      glbBlob = modelProvider === 'hunyuan3d'
        ? await generate3DModelWithHunyuan3D(item.imageUrl, hfToken, aiSettings.spaces.hunyuan3d)
        : await generate3DModelWithTrellis(item.imageUrl, hfToken, aiSettings.spaces.trellis);

      const glbUrl = URL.createObjectURL(glbBlob);

      // Ensure tightBox2d exists (fallback calculation if missing)
      let tightBox2d = item.tightBox2d;
      if (!tightBox2d && item.imageUrl) {
        try {
          tightBox2d = await calculateTightBoundingBox(item.imageUrl);
        } catch (e) {
          console.warn("[App] Failed to calculate fallback tightBox2d:", e);
        }
      }

      const newModelId = `model-${Date.now()}`;
      const newModel3D: Model3D = {
        id: newModelId,
        label: item.label,
        glbUrl: glbUrl,
        posterUrl: item.imageUrl,
        timestamp: Date.now(),
        box_2d: item.box_2d,
        completionExpansionRatio: item.completionExpansionRatio,
        originalPartBox2d: item.originalPartBox2d,
        tightBox2d: tightBox2d,
        provider: modelProvider
      };

      // Note: Scene depth map is generated separately via handleGenerateDepthMap
      // No need to generate per-object depth maps

      setModels3D(prev => [newModel3D, ...prev]);
      addToSelection('3d', [newModelId]);

      // If we are in the standalone generation mode, switch to a workspace mode to view results
      if (mode === 'generate-3d') {
        setMode('batch-remove');
      }

      setActiveTab('3d');

    } catch (e: any) {
      console.error("Failed to generate 3D model", e);
      alert("Failed to generate 3D model: " + e.message);
      if (mode === 'generate-3d') setIsGenerating3DGlobal(false);
    } finally {
      const elapsed = (performance.now() - t0) / 1000;
      setProcessingTimes(prev => new Map(prev).set(`3D Gen: ${item.label}`, elapsed));
      setIsGenerating3DGlobal(false);
      setProcessingIds(prev => { const newSet = new Set(prev); newSet.delete(item.id); return newSet; });
    }
  };

  const handleBatchGenerate3D = async () => {
    const itemsToProcess = filteredCompletedImages.filter(item => selectedItems.has(item.id));
    if (itemsToProcess.length === 0) return;

    setActiveTab('3d');

    if (previewUrl && !depthMapUrl && !isGeneratingDepth) {
      try {
        setIsGeneratingDepth(true);
        const depthUrl = await generateDepthMap(previewUrl, hfToken, aiSettings.spaces.depth);
        setDepthMapUrl(depthUrl);
      } catch (e: any) {
        console.warn("Auto depth map generation failed, continuing without it:", e);
        if (e.message.includes("ZeroGPU")) {
          alert("Warning: Depth Map generation failed due to Hugging Face ZeroGPU quota limits. The 3D model will still be generated, but might lack some depth details.\n\nConsider upgrading your Hugging Face account or waiting for the quota to reset.");
        }
      } finally {
        setIsGeneratingDepth(false);
      }
    }

    setActiveTab('3d');
    setIsBatchGenerating3D(true);
    const t0 = performance.now();

    try {
      for (const item of itemsToProcess) {
        if (models3D.some(m => m.posterUrl === item.imageUrl)) continue;
        await handleGenerate3D(item);
      }
    } finally {
      const elapsed = (performance.now() - t0) / 1000;
      setProcessingTimes(prev => new Map(prev).set('Batch 3D Generation', elapsed));
      setIsBatchGenerating3D(false);
    }
  };



  const handleBatchUploadSelected = async (files: File[]) => {
    if (files.length === 0) return;

    setMode('batch-remove');
    setPreviewUrl(null);
    setOriginalImageDimensions(null);
    setDetectedObjects([]);

    setCompletedImages([]);
    setModels3D([]);
    setDepthMapUrl(null);
    setError(null);

    setActiveTab('original');
    setFilter('all');

    const newImages: CroppedObject[] = [];

    for (const file of files) {
      // Convert to Data URL for persistence
      const url = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsDataURL(file);
      });

      const label = file.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");

      newImages.push({
        id: `upload-${Date.now()}-${Math.random()}`,
        label: label,
        box_2d: [0, 0, 1, 1],
        type: 'object',
        imageUrl: url
      });
    }

    setCroppedImages(prev => [...prev, ...newImages]);
  };

  const handleCompletionUploadSelected = async (files: File[]) => {
    const file = files[0];
    if (!file) return;

    if (!hasAIKeys) {
      openAISettings();
      return;
    }

    setMode('complete-body');

    // Convert to Data URL
    const url = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.readAsDataURL(file);
    });

    setCompletionOriginalUrl(url);
    setCompletionResult(null);
    setError(null);


    // Trigger completion with currently selected target type
    await performCompletion(url, completionTarget);
  };

  const handle3DUploadSelected = async (files: File[]) => {
    const file = files[0];
    if (!file) return;

    setMode('generate-3d');

    // Convert to Data URL
    const url = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.readAsDataURL(file);
    });

    // Create a temporary object structure for the 3D generator
    const tempObject: CroppedObject = {
      id: `3d-source-${Date.now()}`,
      label: file.name.replace(/\.[^/.]+$/, ""),
      box_2d: [0, 0, 1, 1],
      type: 'object',
      imageUrl: url
    };

    setModel3DSource(tempObject);
    setError(null);

  };

  const performCompletion = async (url: string, type: 'person' | 'object') => {
    setIsCompleting(true);
    setError(null);
    setCompletionResult(null);

    try {
      const label = type === 'person' ? "person" : "object";

      // Prepare image (pad if needed to track expansion)
      const { imageUrl: preparedUrl, expansionRatio } = await prepareImageForCompletion(url);

      const generatedUrl = await generateCompletion(preparedUrl, label, type, aiSettings);

      const newObject: CroppedObject = {
        id: `comp-${Date.now()}`,
        label: `Completed ${type === 'person' ? 'Full Body' : 'Object'}`,
        box_2d: [0, 0, 1, 1],
        type: type,
        imageUrl: generatedUrl,
        bgRemovalFailed: false,
        // Convert multiplier (e.g. 1.6) to extension fraction (e.g. 0.6/1.6 = 0.375)
        completionExpansionRatio: (expansionRatio - 1) / expansionRatio
      };

      setCompletionResult(newObject);

    } catch (e: any) {
      console.error(e);
      setError("Failed to complete image: " + (e.message || "Unknown error"));
    } finally {
      setIsCompleting(false);
    }
  };





  const handleCompleteBody = async (item: CroppedObject) => {
    if (!hasAIKeys) {
      openAISettings();
      return;
    }

    // Add to processing IDs for persistent indicator
    setProcessingIds(prev => new Set(prev).add(item.id));
    const t0 = performance.now();

    const MAX_RETRIES = 2;
    let attempt = 0;
    let finalImageUrl = '';
    let expansionRatio = 1;
    let detectedOriginalPartBox2d: [number, number, number, number] | undefined;
    let detectedTightBox2d: [number, number, number, number] | undefined;

    try {
      // Step 1: Estimate canvas expansion needed using the vision provider
      const { verticalRatio, horizontalRatio } = await estimateCanvasExpansion(
        item.imageUrl,
        item.label,
        item.type,
        aiSettings
      );

      while (attempt <= MAX_RETRIES) {
        attempt++;

        // Step 2: Prepare image with estimated (or increased) expansion
        const adjustedVerticalRatio = verticalRatio * (1 + (attempt - 1) * 0.3); // Increase by 30% each retry
        const adjustedHorizontalRatio = horizontalRatio * (1 + (attempt - 1) * 0.15);

        const { imageUrl: preparedUrl, expansionRatio: expRatio } = await prepareImageForCompletion(
          item.imageUrl,
          adjustedVerticalRatio,
          adjustedHorizontalRatio
        );
        expansionRatio = expRatio;

        // Step 3: Generate completion
        const tGen = performance.now();
        const generatedImageUrl = await generateCompletion(
          preparedUrl,
          item.label,
          item.type,
          aiSettings,
          item.description
        );
        const genElapsed = (performance.now() - tGen) / 1000;
        setProcessingTimes(prev => new Map(prev).set(`Generation: ${item.label}`, genElapsed));

        // Step 3.5: Run background removal FIRST, then AKAZE matching on transparent images
        let transparentUrl = generatedImageUrl;
        let extractedTransparentUrl: string | undefined;

        if (bgRemovalAfterCompletion) {
          const tBg = performance.now();
          try {
            // Remove background from completed image (BRIA RMBG 2.0)
            const bgRemovedBlob = await removeBackgroundWithRembg(generatedImageUrl, hfToken, aiSettings.spaces.rmbg);
            transparentUrl = URL.createObjectURL(bgRemovedBlob);

            // Also remove background from extracted image for matching
            try {
              const extractedBgRemovedBlob = await removeBackgroundWithRembg(item.imageUrl, hfToken, aiSettings.spaces.rmbg);
              extractedTransparentUrl = URL.createObjectURL(extractedBgRemovedBlob);
            } catch (extractBgError) {
              console.warn('[Complete Body] Failed to remove BG from extracted image:', extractBgError);
            }
          } catch (bgError) {
            console.warn('[Complete Body] Background removal failed, keeping original:', bgError);
          }
          const bgElapsed = (performance.now() - tBg) / 1000;
          setProcessingTimes(prev => new Map(prev).set(`Compl BG: ${item.label}`, bgElapsed));
        }

        // Step 3.6: Calculate tightBox2d for the completed image first
        const tMatch = performance.now();
        try {

          // Always calculate tightBox2d for the completed image
          const tightBox = await calculateTightBoundingBox(transparentUrl);
          if (tightBox) {
            detectedTightBox2d = tightBox;
          }

          // Then try AKAZE matching for originalPartBox2d
          const targetImage = transparentUrl;
          const templateImage = extractedTransparentUrl || item.imageUrl;
          const matchedBox = await findBestMatchPosition(targetImage, templateImage);
          if (matchedBox) {
            detectedOriginalPartBox2d = matchedBox;
          } else {
            // Fallback: use tightBox2d as originalPartBox2d
            if (tightBox) {
              detectedOriginalPartBox2d = tightBox;
            }
          }
        } catch (matchError) {
          console.warn('[Complete Body] Matching failed:', matchError);
          // Fallback: try to use tightBox2d
          try {
            const tightBox = await calculateTightBoundingBox(transparentUrl);
            if (tightBox) {
              detectedOriginalPartBox2d = tightBox;
              detectedTightBox2d = tightBox; // Also save as tightBox2d
            }
          } catch (tightBoxError) {
            console.warn('[Complete Body] tightBox2d fallback also failed:', tightBoxError);
          }
        }
        const matchElapsed = (performance.now() - tMatch) / 1000;
        setProcessingTimes(prev => new Map(prev).set(`AKAZE: ${item.label}`, matchElapsed));


        // Step 4: Verify completion
        const { isComplete, missingParts } = await verifyCompletion(
          transparentUrl,
          item.label,
          item.type,
          aiSettings
        );

        if (isComplete || attempt > MAX_RETRIES) {
          finalImageUrl = transparentUrl;
          if (!isComplete) {
            console.warn(`[Complete Body] Still incomplete after ${MAX_RETRIES + 1} attempts, using best result`);
          }
          break;
        }

        // Not complete yet - retry with ORIGINAL image but larger canvas
        console.warn(`[Complete Body] Incomplete (missing: ${missingParts.join(', ')}), retrying with larger canvas...`);
        // Loop continues with same item.imageUrl but increased adjustedVerticalRatio/adjustedHorizontalRatio
      }

      const newId = `generated-${item.id}-${Date.now()}`;
      const newLabel = `${item.label} (Completed)`;

      const generatedObject: CroppedObject = {
        ...item,
        id: newId,
        label: newLabel,
        imageUrl: finalImageUrl,
        bgRemovalFailed: false,
        completionExpansionRatio: expansionRatio,
        originalCroppedImageUrl: item.imageUrl,
        originalPartBox2d: detectedOriginalPartBox2d,
        tightBox2d: detectedTightBox2d,
        isRefined: !!detectedOriginalPartBox2d
      };

      setCompletedImages(prev => [generatedObject, ...prev]);
      addToSelection('completed', [newId]);
      setActiveTab('completed');

    } catch (e) {
      console.error("Failed to generate completion", e);
      alert("Failed to generate image completion. You may need to reconnect your Google API Key.");
    } finally {
      const elapsed = (performance.now() - t0) / 1000;
      setProcessingTimes(prev => new Map(prev).set(`Completion: ${item.label}`, elapsed));
      // Remove from processing IDs
      setProcessingIds(prev => { const newSet = new Set(prev); newSet.delete(item.id); return newSet; });
    }
  };

  const handleBatchCompleteExtracted = async () => {
    if (!hasAIKeys) {
      openAISettings();
      return;
    }

    const itemsToProcess = selectedItems.size > 0
      ? filteredCroppedImages.filter(img => selectedItems.has(img.id))
      : filteredCroppedImages;

    if (itemsToProcess.length === 0) return;

    setIsBatchCompleting(true);
    setError(null);
    const t0 = performance.now();

    try {
      setActiveTab('completed');
      // Process sequentially to avoid rate limits
      for (const item of itemsToProcess) {
        const tItem = performance.now();
        try {
          // Prepare image (pad if needed to track expansion)
          const { imageUrl: preparedUrl, expansionRatio } = await prepareImageForCompletion(item.imageUrl);

          const tGen2 = performance.now();
          const generatedImageUrl = await generateCompletion(preparedUrl, item.label, item.type, aiSettings, item.description);
          const genElapsed2 = (performance.now() - tGen2) / 1000;
          setProcessingTimes(prev => new Map(prev).set(`Generation: ${item.label}`, genElapsed2));

          // Run RMBG first, then AKAZE matching on transparent images
          let batchOriginalPartBox2d: [number, number, number, number] | undefined;
          let transparentUrl = generatedImageUrl;
          let extractedTransparentUrl: string | undefined;

          if (bgRemovalAfterCompletion) {
            const tBg2 = performance.now();
            try {
              // Remove background from completed image (BRIA RMBG 2.0)
              const bgRemovedBlob = await removeBackgroundWithRembg(generatedImageUrl, hfToken, aiSettings.spaces.rmbg);
              transparentUrl = URL.createObjectURL(bgRemovedBlob);

              // Also remove background from extracted image for matching
              try {
                const extractedBgRemovedBlob = await removeBackgroundWithRembg(item.imageUrl, hfToken, aiSettings.spaces.rmbg);
                extractedTransparentUrl = URL.createObjectURL(extractedBgRemovedBlob);
              } catch (extractBgError) {
                console.warn('[Batch Complete] Failed to remove BG from extracted:', extractBgError);
              }
            } catch (bgError) {
              console.warn('[Batch Complete] Background removal failed, keeping original:', bgError);
            }
            const bgElapsed2 = (performance.now() - tBg2) / 1000;
            setProcessingTimes(prev => new Map(prev).set(`Compl BG: ${item.label}`, bgElapsed2));
          }

          // Calculate tightBox2d for the completed image first, then try AKAZE matching
          let batchTightBox2d: [number, number, number, number] | undefined;
          const tMatch2 = performance.now();
          try {

            // Always calculate tightBox2d first
            const tightBox = await calculateTightBoundingBox(transparentUrl);
            if (tightBox) {
              batchTightBox2d = tightBox;
            }

            // Then try AKAZE matching for originalPartBox2d
            const targetImage = transparentUrl;
            const templateImage = extractedTransparentUrl || item.imageUrl;
            const matchedBox = await findBestMatchPosition(targetImage, templateImage);
            if (matchedBox) {
              batchOriginalPartBox2d = matchedBox;
            } else {
              // Fallback: use tightBox2d as originalPartBox2d
              if (tightBox) {
                batchOriginalPartBox2d = tightBox;
              }
            }
          } catch (matchError) {
            console.warn('[Batch Complete] Matching failed:', matchError);
            // Fallback: try tightBox2d
            try {
              const tightBox = await calculateTightBoundingBox(transparentUrl);
              if (tightBox) {
                batchOriginalPartBox2d = tightBox;
                batchTightBox2d = tightBox;
              }
            } catch (e) {
              console.warn('[Batch Complete] tightBox2d fallback failed:', e);
            }
          }
          const matchElapsed2 = (performance.now() - tMatch2) / 1000;
          setProcessingTimes(prev => new Map(prev).set(`AKAZE: ${item.label}`, matchElapsed2));


          const newId = `generated-${item.id}-${Date.now()}`;
          const newLabel = `${item.label} (Completed)`;

          const generatedObject: CroppedObject = {
            ...item,
            id: newId,
            label: newLabel,
            imageUrl: transparentUrl,
            bgRemovalFailed: false,
            completionExpansionRatio: expansionRatio,
            originalCroppedImageUrl: item.imageUrl,
            originalPartBox2d: batchOriginalPartBox2d,
            tightBox2d: batchTightBox2d,
            isRefined: !!batchOriginalPartBox2d
          };

          setCompletedImages(prev => [generatedObject, ...prev]);
          addToSelection('completed', [newId]);
        } catch (e) {
          console.error(`Failed to complete ${item.label}`, e);
        } finally {
          const itemElapsed = (performance.now() - tItem) / 1000;
          setProcessingTimes(prev => new Map(prev).set(`Completion: ${item.label}`, itemElapsed));
        }
      }
      handleDeselectAll();
    } catch (e) {
      console.error("Batch completion failed", e);
      setError("Batch completion failed. See console for details.");
    } finally {
      const elapsed = (performance.now() - t0) / 1000;
      setProcessingTimes(prev => new Map(prev).set('Batch Completion', elapsed));
      setIsBatchCompleting(false);
    }
  };

  const handleDeleteModel3D = (id: string) => {
    setModels3D(prev => {
      const newModels = prev.filter(m => m.id !== id);
      // Optional: Revoke object URL of deleted item to free memory
      const deleted = prev.find(m => m.id === id);
      if (deleted) URL.revokeObjectURL(deleted.glbUrl);
      return newModels;
    });
  };

  const handleUpdateCompletedItem = (updatedItem: CroppedObject) => {
    setCompletedImages(prev => prev.map(item => item.id === updatedItem.id ? updatedItem : item));
  };

  const handleDeleteCompletedImage = (id: string) => {
    setCompletedImages(prev => prev.filter(img => img.id !== id));
  };

  const handleDeleteCroppedImage = (id: string) => {
    setCroppedImages(prev => prev.filter(img => img.id !== id));
  };



  const handleBackToMenu = () => {
    setMode('landing');
    // Do NOT clear data here to allow resuming
  };

  const resetAppState = () => {
    setMode('landing');
    setPreviewUrl(null);
    setSourceImageName(null);
    setCompletionOriginalUrl(null);
    setCompletionResult(null);
    setModel3DSource(null);
    setOriginalImageDimensions(null);
    setDetectedObjects([]);
    setCroppedImages([]);

    setCompletedImages([]);
    setModels3D([]);
    setDepthMapUrl(null);
    setError(null);

    setActiveTab('original');
    setFilter('all');
  };

  // --- Project Archiving Functions ---

  const handleSaveProject = async () => {
    setIsArchiving(true);
    try {
      // 1. Convert all blob URLs in states to Data URLs (Base64)
      const archivePreviewUrl = previewUrl ? await blobUrlToDataUrl(previewUrl) : null;

      const archiveCropped = await Promise.all(croppedImages.map(async img => ({
        ...img,
        imageUrl: await blobUrlToDataUrl(img.imageUrl),
        originalCroppedImageUrl: img.originalCroppedImageUrl ? await blobUrlToDataUrl(img.originalCroppedImageUrl) : undefined
      })));



      const archiveCompleted = await Promise.all(completedImages.map(async img => ({
        ...img,
        imageUrl: await blobUrlToDataUrl(img.imageUrl),
        originalCroppedImageUrl: img.originalCroppedImageUrl ? await blobUrlToDataUrl(img.originalCroppedImageUrl) : undefined
      })));

      const archiveModels = await Promise.all(models3D.map(async m => ({
        ...m,
        glbUrl: await blobUrlToDataUrl(m.glbUrl),
        posterUrl: await blobUrlToDataUrl(m.posterUrl)
      })));

      const archiveDepthMapUrl = depthMapUrl ? await blobUrlToDataUrl(depthMapUrl) : null;

      // 2. Create Archive Object
      const archive: ProjectArchive = {
        version: 1,
        timestamp: Date.now(),
        mode,
        previewUrl: archivePreviewUrl,
        originalImageDimensions,
        detectedObjects,
        croppedImages: archiveCropped,
        completedImages: archiveCompleted,
        models3D: archiveModels,
        depthMapUrl: archiveDepthMapUrl,
        processingTimes: Object.fromEntries(processingTimes),
        sourceImageName: sourceImageName ?? undefined
      };

      // File name: <photo name>_<furthest stage>_<local date-time>.json
      // e.g. 2PersonsAroundTable_3d-models_20261118-143005.json
      const stage =
        archive.models3D.length > 0 && archive.depthMapUrl ? 'scene'
          : archive.models3D.length > 0 ? '3d-models'
            : archive.completedImages.length > 0 ? 'completed'
              : archive.croppedImages.length > 0 ? 'detected'
                : 'empty';
      const baseName = (sourceImageName || 'project')
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'project';
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      // 3. Download JSON
      const blob = new Blob([JSON.stringify(archive)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${baseName}_${stage}_${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

    } catch (e) {
      console.error("Failed to save project", e);
      alert("Failed to save project. See console for details.");
    } finally {
      setIsArchiving(false);
    }
  };

  const handleLoadProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsArchiving(true);
    try {
      // Clear existing state first to prevent ID collisions and stale render issues
      resetAppState();

      const text = await file.text();
      const archive = JSON.parse(text) as ProjectArchive;

      if (!archive.version) throw new Error("Invalid project file");

      // Restore Mode
      // If we loaded data but were in landing, switch to a workspace view
      let newMode = archive.mode as AppMode;
      if (newMode === 'landing' && archive.croppedImages.length > 0) {
        newMode = 'analyze';
      }
      setMode(newMode);

      setOriginalImageDimensions(archive.originalImageDimensions);
      setSourceImageName(archive.sourceImageName ?? null);
      setDetectedObjects(archive.detectedObjects);

      // Restore URLs
      if (archive.previewUrl) {
        setPreviewUrl(await dataUrlToBlobUrl(archive.previewUrl));
      }

      const restoredCropped = await Promise.all(archive.croppedImages.map(async img => ({
        ...img,
        imageUrl: await dataUrlToBlobUrl(img.imageUrl),
        originalCroppedImageUrl: (img.originalCroppedImageUrl && !img.originalCroppedImageUrl.startsWith('blob:'))
          ? await dataUrlToBlobUrl(img.originalCroppedImageUrl)
          : undefined
      })));
      setCroppedImages(restoredCropped);



      const restoredCompleted = await Promise.all(archive.completedImages.map(async img => ({
        ...img,
        imageUrl: await dataUrlToBlobUrl(img.imageUrl),
        originalCroppedImageUrl: (img.originalCroppedImageUrl && !img.originalCroppedImageUrl.startsWith('blob:'))
          ? await dataUrlToBlobUrl(img.originalCroppedImageUrl)
          : undefined
      })));
      setCompletedImages(restoredCompleted);

      const restoredModels = await Promise.all(archive.models3D.map(async m => ({
        ...m,
        glbUrl: await dataUrlToBlobUrl(m.glbUrl),
        posterUrl: await dataUrlToBlobUrl(m.posterUrl)
      })));
      setModels3D(restoredModels);

      if (archive.depthMapUrl) {
        setDepthMapUrl(await dataUrlToBlobUrl(archive.depthMapUrl));
      }

      // Reset errors
      setError(null);


      // Restore processing times
      if (archive.processingTimes) {
        setProcessingTimes(new Map(Object.entries(archive.processingTimes)));
      }

      // Restore selected items for 3D models (so they appear in 3D Scene)
      if (restoredModels.length > 0) {
        setSelectedItems(new Set(restoredModels.map(m => m.id)));
      }

      // Navigate to a relevant tab
      if (archive.depthMapUrl && restoredModels.length > 0) setActiveTab('scene');
      else if (restoredModels.length > 0) setActiveTab('3d');
      else if (restoredCompleted.length > 0) setActiveTab('completed');
      else setActiveTab('original');

    } catch (e) {
      console.error("Failed to load project", e);
      alert("Failed to load project file. It might be corrupted or incompatible.");
    } finally {
      setIsArchiving(false);
      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const UploadMoreButton = () => (
    <div className="relative inline-block ml-4">
      <input
        type="file"
        multiple
        accept="image/*"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleBatchUploadSelected(Array.from(e.target.files));
          }
        }}
      />
      <button className="text-sm bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1">
        <Upload size={14} /> Add More Images
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 pb-20" >
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 cursor-pointer" onClick={handleBackToMenu}>
            <div className="bg-blue-600 p-2 rounded-lg text-white">
              <Scan size={24} />
            </div>
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-700 to-indigo-600">
              3D Scene Reconstruction from One Image
            </h1>
          </div>

          <div className="flex items-center gap-4 w-full md:w-auto flex-wrap">

            {/* Project Actions */}
            <div className="flex items-center gap-2 mr-2 border-r border-slate-200 pr-4">
              <button
                onClick={handleSaveProject}
                disabled={isArchiving || (croppedImages.length === 0 && !previewUrl)}
                className={`flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors
                    ${isArchiving || (croppedImages.length === 0 && !previewUrl)
                    ? 'bg-slate-50 text-slate-400 border-slate-200 cursor-not-allowed'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
                title="Save Project (Download JSON)"
              >
                {isArchiving ? <Spinner /> : <Save size={14} />}
                Save
              </button>

              <div className="relative">
                <input
                  type="file"
                  accept=".json"
                  ref={fileInputRef}
                  className="hidden"
                  onChange={handleLoadProject}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isArchiving}
                  className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-full border bg-white text-slate-700 border-slate-300 hover:bg-slate-50 transition-colors"
                  title="Load Project (Upload JSON)"
                >
                  <FolderOpen size={14} />
                  Load
                </button>
              </div>
            </div>

            {/* Settings Area */}
            {(
              <div className="flex flex-col items-end gap-1.5">
                {/* Row 1: AI settings + HF Token */}
                <div className="flex items-center gap-3 bg-slate-50 px-3 py-1 rounded-lg border border-slate-100">
                  {/* AI providers */}
                  <button
                    onClick={openAISettings}
                    title="AI Settings: providers, API keys and models"
                    className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition-colors border ${hasAIKeys
                      ? 'bg-green-100 text-green-700 border-green-200'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                  >
                    <div className={`w-1.5 h-1.5 rounded-full ${hasAIKeys ? 'bg-green-500' : 'bg-slate-300'}`} />
                    {hasAIKeys
                      ? `AI: ${PROVIDER_LABELS[aiSettings.visionProvider]} / ${PROVIDER_LABELS[aiSettings.imageProvider]}`
                      : 'Set API Keys'}
                  </button>

                  {/* HF Token */}
                  <input
                    type="password"
                    placeholder="HF Token"
                    value={hfToken}
                    onChange={(e) => setHfToken(e.target.value)}
                    className="w-24 px-2 py-0.5 text-xs border border-slate-300 rounded focus:outline-none focus:border-blue-500"
                    title="Hugging Face token: required for 3D generation (TRELLIS.2 / Hunyuan3D-2.1), recommended for background removal and depth estimation"
                  />

                </div>

                {/* Row 2: 3D Model Settings */}
                <div className="flex items-center gap-3 bg-slate-50 px-3 py-1 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">3D</span>
                  <div className="flex bg-white rounded-md border border-slate-200 p-0.5">
                    <button
                      onClick={() => setModelProvider('trellis')}
                      className={`px-1.5 py-0.5 text-[11px] rounded-sm transition-colors ${modelProvider === 'trellis' ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      TRELLIS.2
                    </button>
                    <button
                      onClick={() => setModelProvider('hunyuan3d')}
                      className={`px-1.5 py-0.5 text-[11px] rounded-sm transition-colors ${modelProvider === 'hunyuan3d' ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Hunyuan3D-2.1
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">

        {/* LANDING PAGE MODE */}
        {mode === 'landing' && (
          <div className="max-w-4xl mx-auto mt-8 space-y-12">
            <div className="text-center space-y-4">
              <h2 className="text-4xl font-extrabold text-slate-900 tracking-tight">
                3D Scene Reconstruction from One Image
              </h2>
              <p className="text-lg text-slate-600">
                Transform 2D photos into immersive 3D scenes. Detect, Edit, and Reconstruct.
              </p>

              {/* Resume Button */}
              {(croppedImages.length > 0 || completedImages.length > 0 || models3D.length > 0) && (
                <div className="flex justify-center mt-4">
                  <button
                    onClick={() => setMode('analyze')}
                    className="bg-teal-600 text-white px-8 py-3 rounded-full font-bold text-lg shadow-lg hover:bg-teal-700 transition-all flex items-center gap-2 animate-pulse"
                  >
                    <MonitorPlay size={24} />
                    Resume Workspace
                  </button>
                </div>
              )}
            </div>

            {!hasAIKeys && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center max-w-lg mx-auto">
                <h3 className="text-lg font-bold text-amber-800 mb-2">API Key Required</h3>
                <p className="text-amber-700 mb-4 text-sm">
                  Object detection and image completion use Gemini or OpenAI. Choose the providers and enter the API keys in AI Settings.
                </p>
                <button
                  onClick={openAISettings}
                  className="bg-amber-600 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-amber-700 transition-colors shadow-sm inline-flex items-center gap-2"
                >
                  <Plug size={18} /> Open AI Settings
                </button>
              </div>
            )}

            <div className={`grid md:grid-cols-2 lg:grid-cols-3 gap-6 ${!hasAIKeys ? 'opacity-50 pointer-events-none grayscale-[0.5]' : ''}`}>
              {/* Option 1: AI Analysis */}
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 hover:shadow-md transition-shadow flex flex-col h-full">
                <div className="flex-1 space-y-4 mb-6">
                  <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center text-blue-600 mb-4">
                    <Scan size={28} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900">1. Detect & Crop</h3>
                  <p className="text-slate-600 text-sm">
                    Detect main objects in a photo and crop them automatically.
                  </p>
                </div>
                <div className="h-40">
                  <ImageUploader
                    onImageSelected={(file) => {
                      if (croppedImages.length > 0) {
                        if (window.confirm("Starting new analysis will clear current workspace. Continue?")) {
                          // Manually clear state before starting new analysis
                          setDetectedObjects([]);
                          setCroppedImages([]);
                          setCompletedImages([]);
                          setModels3D([]);
                          handleAnalysisImageSelected(file);
                        }
                      } else {
                        handleAnalysisImageSelected(file);
                      }
                    }}
                    isLoading={false}
                    title="Analyze Scene"
                    description="Upload full photo"
                  />
                </div>
              </div>


              {/* Option 3: Image Completion */}
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 hover:shadow-md transition-shadow flex flex-col h-full">
                <div className="flex-1 space-y-4 mb-2">
                  <div className="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center text-indigo-600 mb-4">
                    <Wand2 size={28} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900">2. Image Completion</h3>
                  <p className="text-slate-600 text-sm">
                    Generate missing parts for a person or object.
                  </p>
                </div>

                {/* Target Type Toggle */}
                <div className="flex bg-slate-100 p-1 rounded-lg mb-4">
                  <button
                    onClick={() => setCompletionTarget('person')}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1 ${completionTarget === 'person'
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-500 hover:text-slate-700'
                      }`}
                  >
                    <User size={12} /> Person
                  </button>
                  <button
                    onClick={() => setCompletionTarget('object')}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1 ${completionTarget === 'object'
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-500 hover:text-slate-700'
                      }`}
                  >
                    <Box size={12} /> Object
                  </button>
                </div>

                {/* BG Removal After Completion Option */}
                <label className="flex items-center gap-2 text-xs text-slate-600 mb-4 cursor-pointer hover:text-slate-800">
                  <input
                    type="checkbox"
                    checked={bgRemovalAfterCompletion}
                    onChange={(e) => setBgRemovalAfterCompletion(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>RMBG BG removal after completion</span>
                </label>

                <div className="h-40">
                  <ImageUploader
                    onImageSelected={handleCompletionUploadSelected}
                    isLoading={false}
                    title="Upload Partial"
                    description="Upload cropped image"
                    icon={<Wand2 size={24} />}
                  />
                </div>
              </div>

              {/* Option 4: 3D Generation */}
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 hover:shadow-md transition-shadow flex flex-col h-full">
                <div className="flex-1 space-y-4 mb-6">
                  <div className="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center text-orange-600 mb-4">
                    <Box size={28} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900">3. 3D Generation</h3>
                  <p className="text-slate-600 text-sm">
                    Turn your completed images into 3D models (GLB).
                  </p>
                </div>
                <div className="h-40">
                  <ImageUploader
                    onImageSelected={handle3DUploadSelected}
                    isLoading={false}
                    title="Upload Image"
                    description="Upload transparent PNG"
                    icon={<Box size={24} />}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 3D GENERATION MODE (DIRECT UPLOAD) */}
        {mode === 'generate-3d' && model3DSource && (
          <div className="max-w-xl mx-auto">
            <button
              onClick={handleBackToMenu}
              className="flex items-center gap-2 text-slate-500 hover:text-blue-600 font-medium transition-colors mb-6"
            >
              <ArrowLeft size={16} /> Back to Menu
            </button>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
              <div className="w-16 h-16 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center mx-auto mb-6">
                <Box size={32} />
              </div>

              <h2 className="text-2xl font-bold text-slate-900 mb-2">Generate 3D Model</h2>
              <p className="text-slate-600 mb-8">
                Convert your image into a 3D GLB file using the selected 3D generator.
              </p>

              <div className="relative w-64 h-64 mx-auto bg-slate-100 rounded-xl overflow-hidden mb-8 border border-slate-200 flex items-center justify-center">
                <img src={model3DSource.imageUrl} alt="Source" className="max-w-full max-h-full object-contain" />

                {/* Overlay checkboard */}
                <div className="absolute inset-0 -z-10 opacity-30" style={{
                  backgroundImage: 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)',
                  backgroundSize: '20px 20px',
                  backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px'
                }}></div>
              </div>

              <button
                onClick={() => handleGenerate3D(model3DSource)}
                disabled={isGenerating3DGlobal}
                className={`w-full py-3 rounded-lg font-bold text-white transition-all flex items-center justify-center gap-2 shadow-md
                          ${isGenerating3DGlobal
                    ? 'bg-slate-300 cursor-not-allowed'
                    : 'bg-orange-500 hover:bg-orange-600'}`}
              >
                {isGenerating3DGlobal ? <Spinner /> : <Box size={20} />}
                {isGenerating3DGlobal ? 'Generating...' : 'Generate 3D Model'}
              </button>
            </div>
          </div>
        )}

        {/* COMPLETION MODE */}
        {mode === 'complete-body' && (
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <button
                onClick={handleBackToMenu}
                className="flex items-center gap-2 text-slate-500 hover:text-blue-600 font-medium transition-colors"
              >
                <ArrowLeft size={16} /> Back to Menu
              </button>

              {/* Mode Toggle in View */}
              <div className="flex bg-white border border-slate-200 p-1 rounded-lg">
                <button
                  onClick={() => {
                    if (completionTarget !== 'person') {
                      setCompletionTarget('person');
                      if (completionOriginalUrl) performCompletion(completionOriginalUrl, 'person');
                    }
                  }}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all flex items-center gap-2 ${completionTarget === 'person'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-500 hover:text-slate-700'
                    }`}
                  disabled={isCompleting}
                >
                  <User size={14} /> Person (Full Body)
                </button>
                <button
                  onClick={() => {
                    if (completionTarget !== 'object') {
                      setCompletionTarget('object');
                      if (completionOriginalUrl) performCompletion(completionOriginalUrl, 'object');
                    }
                  }}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all flex items-center gap-2 ${completionTarget === 'object'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-500 hover:text-slate-700'
                    }`}
                  disabled={isCompleting}
                >
                  <Box size={14} /> General Object
                </button>
              </div>
            </div>

            <h2 className="text-2xl font-bold text-slate-900 mb-6 flex items-center gap-2">
              <Wand2 className="text-indigo-600" /> Image Completion
            </h2>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-red-700 mb-8">
                <AlertCircle size={20} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Error</p>
                  <p className="text-sm opacity-90">{error}</p>
                </div>
              </div>
            )}


            <div className="grid md:grid-cols-2 gap-8">
              {/* Left: Original */}
              <div className="space-y-4">
                <h3 className="font-semibold text-slate-700">Original Upload</h3>
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex items-center justify-center min-h-[400px]">
                  {completionOriginalUrl && (
                    <img src={completionOriginalUrl} alt="Original" className="max-w-full max-h-[400px] object-contain" />
                  )}
                </div>
              </div>

              {/* Right: Result */}
              <div className="space-y-4">
                <h3 className="font-semibold text-slate-700 flex items-center gap-2">
                  Generated Result
                </h3>

                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex items-center justify-center min-h-[400px] relative overflow-hidden">
                  {isCompleting && (
                    <div className="text-center">
                      <Spinner />
                      <p className="mt-4 text-indigo-600 font-medium animate-pulse">Generating completion...</p>
                      <p className="text-xs text-slate-400 mt-2">Target: {completionTarget === 'person' ? 'Person' : 'Object'}</p>
                    </div>
                  )}


                  {!isCompleting && completionResult && (
                    <div className="w-full h-full flex flex-col items-center">
                      <div className="rounded-lg overflow-hidden mb-4">
                        <img src={completionResult.imageUrl} alt="Result" className="max-w-full max-h-[400px] object-contain" />
                      </div>

                      <div className="flex gap-4">
                        <a
                          href={completionResult.imageUrl}
                          download="completed_result.png"
                          className="bg-indigo-600 text-white px-6 py-2 rounded-full shadow hover:bg-indigo-700 transition-colors flex items-center gap-2"
                        >
                          <ImageIcon size={18} /> Download
                        </a>
                        <button
                          onClick={() => completionOriginalUrl && performCompletion(completionOriginalUrl, completionTarget)}
                          className="bg-white text-indigo-600 border border-indigo-200 px-4 py-2 rounded-full shadow-sm hover:bg-indigo-50 transition-colors flex items-center gap-2"
                        >
                          <RefreshCw size={16} /> Regenerate
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div >
        )}

        {/* WORKSPACE MODES (Analyze or Batch) */}
        {
          (mode === 'analyze' || mode === 'batch-remove') && (
            <div>
              <button
                onClick={handleBackToMenu}
                className="flex items-center gap-2 text-slate-500 hover:text-blue-600 mb-6 font-medium transition-colors"
              >
                <ArrowLeft size={16} /> Back to Menu
              </button>

              <div className={`grid grid-cols-1 ${mode === 'analyze' ? 'lg:grid-cols-12' : 'lg:grid-cols-1'} gap-8`}>

                {/* Left Column: Original Image (Only for Analysis Mode) */}
                {mode === 'analyze' && (
                  <div className="lg:col-span-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                        <span className="bg-slate-200 text-slate-600 w-6 h-6 rounded-full flex items-center justify-center text-xs">1</span>
                        Original Image
                      </h3>
                    </div>

                    <div className="relative rounded-xl overflow-hidden shadow-sm border border-slate-200 bg-white group">
                      {previewUrl && (
                        <>
                          <img
                            src={previewUrl}
                            alt="Original"
                            className="w-full h-auto block"
                          />
                          {/* Bounding Boxes Layer */}
                          {!isAnalyzing && detectedObjects.length > 0 && (
                            <BoundingBoxOverlay objects={detectedObjects} />
                          )}
                        </>
                      )}

                      {/* Analyzing Overlay */}
                      {isAnalyzing && (
                        <div className="absolute inset-0 bg-white/60 backdrop-blur-sm flex items-center justify-center flex-col gap-3">
                          <Spinner />
                          <p className="text-sm font-medium text-slate-600 animate-pulse">Scanning objects...</p>
                        </div>
                      )}
                    </div>

                    {!isAnalyzing && detectedObjects.length > 0 && (
                      <p className="text-sm text-slate-500 text-center">
                        Found {detectedObjects.length} object{detectedObjects.length !== 1 ? 's' : ''}.
                      </p>
                    )}

                    {/* Depth Map */}
                    {!isAnalyzing && depthMapUrl && (
                      <div className="mt-4 bg-white rounded-xl border border-slate-200 p-4">
                        <h4 className="font-semibold text-slate-700 mb-2 flex items-center gap-2">
                          <Layers size={16} /> Depth Map
                        </h4>
                        <p className="text-xs text-slate-500 mb-3">
                          Used for 3D scene reconstruction accuracy.
                        </p>
                        <div className="relative group">
                          <img
                            src={depthMapUrl}
                            alt="Depth Map"
                            className="w-full rounded-lg border border-slate-200 grayscale"
                            onError={(e) => {
                              console.error("Failed to load depth map image");
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/50 transition-opacity rounded-lg">
                            <p className="text-white text-xs font-medium">Brighter = Closer</p>
                          </div>
                        </div>
                      </div>
                    )}

                  </div>
                )}

                {/* Right Column (or Full Width): Results */}
                <div className={`${mode === 'analyze' ? 'lg:col-span-7' : 'w-full'} space-y-4 flex flex-col h-full`}>

                  {/* Controls Header */}
                  <div className="flex flex-col gap-4 border-b border-slate-200 pb-2">
                    {/* Tabs */}
                    <div className="flex gap-4 overflow-x-auto w-full border-b border-slate-100 pb-2">
                      <button
                        onClick={() => setActiveTab('original')}
                        className={`pb-2 text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ${activeTab === 'original'
                          ? 'text-blue-600 border-b-2 border-blue-600'
                          : 'text-slate-500 hover:text-slate-700'
                          }`}
                      >
                        <ImageIcon size={16} />
                        {mode === 'analyze' ? 'Extracted' : 'Uploaded'}
                        <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-xs">
                          {filteredCroppedImages.length}
                        </span>
                      </button>

                      <button
                        onClick={() => setActiveTab('completed')}
                        className={`pb-2 text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ${activeTab === 'completed'
                          ? 'text-indigo-600 border-b-2 border-indigo-600'
                          : 'text-slate-500 hover:text-slate-700'
                          }`}
                      >
                        <Star size={16} />
                        Completed
                        <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-xs">
                          {filteredCompletedImages.length}
                        </span>
                      </button>

                      <button
                        onClick={() => setActiveTab('3d')}
                        className={`pb-2 text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ${activeTab === '3d'
                          ? 'text-orange-600 border-b-2 border-orange-600'
                          : 'text-slate-500 hover:text-slate-700'
                          }`}
                      >
                        <Box size={16} />
                        3D Models
                        <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-xs">
                          {models3D.length}
                        </span>
                      </button>

                      {/* 3D Scene Tab - Available when depth map exists */}
                      {previewUrl && depthMapUrl && (
                        <button
                          onClick={() => setActiveTab('scene')}
                          className={`pb-2 text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ${activeTab === 'scene'
                            ? 'text-teal-600 border-b-2 border-teal-600'
                            : 'text-slate-500 hover:text-slate-700'
                            }`}
                        >
                          <Cuboid size={16} />
                          3D Scene
                        </button>
                      )}

                    </div>

                    {/* Filters & Action */}
                    <div className="flex items-center justify-end gap-3">
                      {/* Selection Controls */}
                      {activeTab !== '3d' && activeTab !== 'scene' && (
                        <div className="flex items-center gap-2 mr-2 border-r border-slate-200 pr-4">
                          <button onClick={handleSelectAll} className="text-xs font-medium text-blue-600 hover:text-blue-800">All</button>
                          <span className="text-slate-300">|</span>
                          <button onClick={handleDeselectAll} className="text-xs font-medium text-slate-500 hover:text-slate-700">None</button>
                          <span className="text-xs text-slate-400 ml-1">({selectedItems.size})</span>
                        </div>
                      )}



                      {/* Delete All Button */}
                      {activeTab !== 'scene' && (
                        <button
                          onClick={() => setShowDeleteConfirm(true)}
                          className="text-xs px-3 py-1.5 rounded-full font-medium transition-all flex items-center gap-1.5 whitespace-nowrap bg-red-50 text-red-600 hover:bg-red-100 border border-red-100"
                          title="Delete All Items in Tab"
                        >
                          <Trash2 size={12} />
                          Delete All
                        </button>
                      )}

                      {/* Show "Add More" only in batch mode and original tab */}
                      {mode === 'batch-remove' && activeTab === 'original' && (
                        <UploadMoreButton />
                      )}



                      {/* Filter */}
                      {mode === 'analyze' && croppedImages.length > 0 && activeTab !== '3d' && activeTab !== 'scene' && (
                        <div className="flex items-center bg-slate-100 rounded-lg p-1">
                          <button
                            onClick={() => setFilter('all')}
                            className={`px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${filter === 'all'
                              ? 'bg-white text-slate-800 shadow-sm'
                              : 'text-slate-500 hover:text-slate-700'
                              }`}
                          >
                            <Box size={12} />
                            All
                          </button>
                          <button
                            onClick={() => setFilter('person')}
                            className={`px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${filter === 'person'
                              ? 'bg-white text-slate-800 shadow-sm'
                              : 'text-slate-500 hover:text-slate-700'
                              }`}
                          >
                            <User size={12} />
                            People
                          </button>
                        </div>
                      )}

                      {activeTab === 'original' && croppedImages.length > 0 && (
                        <>


                          <button
                            onClick={handleBatchCompleteExtracted}
                            disabled={isBatchCompleting || !hasAIKeys || filteredCroppedImages.length === 0}
                            className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all flex items-center gap-1.5 whitespace-nowrap
                             ${(isBatchCompleting || !hasAIKeys || filteredCroppedImages.length === 0)
                                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'
                              }`}
                            title={!hasAIKeys ? "Set the API keys in AI Settings first" : `Complete ${selectedItems.size > 0 ? selectedItems.size : 'all'} items (Skip BG Removal)`}
                          >
                            <Wand2 size={12} />
                            {selectedItems.size > 0 ? `Complete (${selectedItems.size})` : 'Complete All'}
                          </button>
                        </>
                      )}



                      {activeTab === 'completed' && selectedItems.size > 0 && (
                        <button
                          onClick={handleBatchGenerate3D}
                          disabled={isBatchGenerating3D}
                          className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all flex items-center gap-1.5 whitespace-nowrap shadow-sm ${isBatchGenerating3D ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-orange-600 text-white hover:bg-orange-700'}`}
                        >
                          {isBatchGenerating3D ? <Spinner size={12} /> : <Box size={12} />}
                          Generate 3D ({selectedItems.size})
                        </button>
                      )}

                      {activeTab === 'completed' && filteredCompletedImages.length > 0 && (
                        <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer hover:text-slate-800 transition-colors border border-slate-200 px-3 py-1.5 rounded-full bg-white hover:bg-slate-50">
                          <input
                            type="checkbox"
                            checked={showBoundingBoxes}
                            onChange={(e) => setShowBoundingBoxes(e.target.checked)}
                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                          />
                          Show Bounding Boxes
                        </label>
                      )}
                    </div>
                  </div>

                  {/* Error State */}
                  {error && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-red-700 mb-4">
                      <AlertCircle size={20} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium">Error</p>
                        <p className="text-sm opacity-90">{error}</p>
                      </div>
                    </div>
                  )}

                  {/* Content Area */}
                  <div className="flex-1 min-h-[300px]">

                    {/* ORIGINAL TAB */}
                    {activeTab === 'original' && (
                      <>
                        {/* Loading State */}
                        {isAnalyzing && !error && (
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                            {[1, 2, 3].map((i) => (
                              <div key={i} className="aspect-square bg-slate-100 rounded-xl relative overflow-hidden">
                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent animate-shimmer" style={{ backgroundSize: '200% 100%' }}></div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Results Grid */}
                        {!isAnalyzing && filteredCroppedImages.length > 0 && (
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                            {filteredCroppedImages.map((item) => (
                              <ResultCard
                                key={item.id}
                                item={item}
                                onCompleteBody={handleCompleteBody}

                                selected={selectedItems.has(item.id)}
                                onSelect={(selected) => handleSelect(item.id, selected)}
                                onDelete={() => handleDeleteCroppedImage(item.id)}
                                isProcessing={processingIds.has(item.id)}
                              />
                            ))}
                          </div>
                        )}

                        {!isAnalyzing && !error && croppedImages.length === 0 && (
                          <div className="h-64 flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                            <Sparkles size={32} className="mb-2 opacity-50" />
                            <p>Ready to generate crops</p>
                          </div>
                        )}
                      </>
                    )}



                    {/* COMPLETED TAB */}
                    {activeTab === 'completed' && (
                      <>
                        {isBatchCompleting && (
                          <div className="flex items-center justify-center gap-3 p-4 bg-indigo-50 rounded-xl border border-indigo-100 mb-4">
                            <Spinner />
                            <p className="font-medium text-indigo-700 animate-pulse">Generating completions...</p>
                          </div>
                        )}

                        {filteredCompletedImages.length > 0 ? (
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                            {filteredCompletedImages.map((item) => (
                              <div key={item.id} className="relative group">
                                <div className="rounded-xl overflow-hidden">
                                  <ResultCard
                                    item={item}
                                    onDelete={() => handleDeleteCompletedImage(item.id)}
                                    onGenerate3D={handleGenerate3D}
                                    selected={selectedItems.has(item.id)}
                                    onSelect={(selected) => handleSelect(item.id, selected)}
                                    onUpdate={handleUpdateCompletedItem}
                                    showBoundingBox={showBoundingBoxes}
                                    isProcessing={processingIds.has(item.id)}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="h-64 flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50 text-center px-6">
                            <Wand2 size={32} className="mb-2 opacity-50" />
                            <p>No completed images yet.</p>
                          </div>
                        )}
                      </>
                    )}
                    {/* 3D MODELS TAB */}
                    {activeTab === '3d' && (
                      <>
                        <div className="flex items-center justify-between mb-6">
                          <h3 className="font-semibold text-slate-700 flex items-center gap-2">
                            <Box size={20} /> 3D Models
                          </h3>
                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer hover:text-slate-800 transition-colors border border-slate-200 px-3 py-1.5 rounded-full bg-white hover:bg-slate-50">
                              <input
                                type="checkbox"
                                checked={showBoundingBoxes}
                                onChange={(e) => setShowBoundingBoxes(e.target.checked)}
                                className="w-4 h-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500 cursor-pointer"
                              />
                              Show Bounding Boxes
                            </label>
                            {models3D.some(m => selectedItems.has(m.id)) && (
                              <button
                                onClick={() => {
                                  const selectedModelIds = models3D.filter(m => selectedItems.has(m.id)).map(m => m.id);
                                  selectedModelIds.forEach(id => handleDeleteModel3D(id));
                                  const newSet = new Set<string>(selectedItems);
                                  selectedModelIds.forEach(id => newSet.delete(id));
                                  setSelectedItems(newSet);
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-red-600 border border-red-200 bg-white hover:bg-red-50 transition-colors"
                              >
                                <Trash2 size={14} />
                                Delete Selected ({models3D.filter(m => selectedItems.has(m.id)).length})
                              </button>
                            )}
                            <button
                              onClick={handleGenerateDepthMap}
                              disabled={isGeneratingDepth || models3D.length === 0}
                              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-colors ${isGeneratingDepth
                                ? 'bg-slate-100 text-slate-400'
                                : 'bg-teal-600 text-white hover:bg-teal-700'
                                }`}
                            >
                              {isGeneratingDepth ? <Spinner /> : <Cuboid size={16} />}
                              {isGeneratingDepth ? 'Generating Scene...' : 'Generate 3D Scene'}
                            </button>
                          </div>
                        </div>

                        {(isBatchGenerating3D || isGenerating3DGlobal) && (
                          <div className="flex items-center justify-center gap-3 p-4 bg-orange-50 rounded-xl border border-orange-100 mb-4">
                            <Spinner />
                            <p className="font-medium text-orange-700 animate-pulse">Generating 3D models...</p>
                          </div>
                        )}

                        {models3D.length > 0 ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                            {models3D.map((model) => (
                              <div key={model.id}>
                                <Model3DCard
                                  model={model}
                                  onDelete={() => handleDeleteModel3D(model.id)}
                                  selected={selectedItems.has(model.id)}
                                  onSelect={(selected) => handleSelect(model.id, selected)}
                                  showBoundingBox={showBoundingBoxes}
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="h-64 flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50 text-center px-6">
                            <Box size={32} className="mb-2 opacity-50" />
                            <p>No 3D models generated yet.</p>
                            <p className="text-sm mt-2 text-slate-500">
                              Go to the "Completed" tab and click the cube icon <Box size={12} className="inline" /> to generate 3D models.
                            </p>
                          </div>
                        )}
                      </>
                    )}

                    {/* 3D SCENE TAB - Using Depth-Based Positioning */}
                    {/* Keep mounted to preserve state, toggle visibility */}
                    {previewUrl && depthMapUrl && (
                      <div style={{ display: activeTab === 'scene' ? 'block' : 'none' }} className="bg-white rounded-xl border border-slate-200 p-6">
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="font-semibold text-slate-700 flex items-center gap-2">
                            <Cuboid size={20} /> 3D Scene
                          </h3>
                          <button
                            onClick={() => {
                              if (depthMapUrl) URL.revokeObjectURL(depthMapUrl);
                              setDepthMapUrl(null);
                              setActiveTab('3d');
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-red-600 border border-red-200 bg-white hover:bg-red-50 transition-colors"
                          >
                            <Trash2 size={14} />
                            Delete Scene
                          </button>
                        </div>
                        <p className="text-sm text-slate-600 mb-4">
                          Interactive 3D scene with models positioned using depth map information.
                        </p>
                        <div className="min-h-[600px]">
                          <DepthOnlyScene
                            key={`${depthMapUrl}-${models3D.filter(m => selectedItemsPerTab['3d'].has(m.id)).map(m => m.id).join('-')}`}
                            imageUrl={previewUrl}
                            depthMapUrl={depthMapUrl}
                            originalAspectRatio={originalImageDimensions ? originalImageDimensions.width / originalImageDimensions.height : 1}
                            detectedObjects={detectedObjects}
                            positionedModels={positionedModels}
                            showModels={true}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        }

        {/* Delete Confirmation Modal */}
        {
          showDeleteConfirm && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
              <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200">
                <div className="flex items-center gap-4 mb-4 text-red-600">
                  <div className="bg-red-100 p-3 rounded-full">
                    <AlertCircle size={24} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900">Delete All Items?</h3>
                </div>

                <p className="text-slate-600 mb-6 leading-relaxed">
                  Are you sure you want to delete <span className="font-semibold text-slate-900">all items</span> in the <span className="font-semibold text-slate-900 capitalize">{activeTab}</span> tab?
                  This action cannot be undone.
                </p>

                <div className="flex items-center justify-end gap-3">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (activeTab === 'original') setCroppedImages([]);

                      else if (activeTab === 'completed') setCompletedImages([]);
                      else if (activeTab === '3d') setModels3D([]);
                      setSelectedItems(new Set());
                      setShowDeleteConfirm(false);
                    }}
                    className="px-4 py-2 bg-red-600 text-white font-medium rounded-lg hover:bg-red-700 shadow-lg shadow-red-200 transition-all flex items-center gap-2"
                  >
                    <Trash2 size={16} />
                    Yes, Delete All
                  </button>
                </div>
              </div>
            </div>
          )
        }


        {/* Processing Times Panel */}
        {
          processingTimes.size > 0 && (
            <div className="fixed bottom-4 right-4 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-xl shadow-lg p-3 max-w-sm z-50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-600">⏱ Processing Times</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const rows = ['Process,Time (s)'];
                      processingTimes.forEach((seconds, key) => {
                        rows.push(`"${key}",${seconds.toFixed(1)}`);
                      });
                      const csv = rows.join('\n');
                      const blob = new Blob([csv], { type: 'text/csv' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `processing_times_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
                    title="Download CSV"
                  >
                    <Download size={12} />
                  </button>
                  <button
                    onClick={() => setProcessingTimes(new Map())}
                    className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {Array.from(processingTimes.entries()).map(([key, seconds]) => (
                  <div key={key} className="flex items-center justify-between text-xs">
                    <span className="text-slate-500 truncate mr-2">{key}</span>
                    <span className="text-slate-700 font-mono font-medium whitespace-nowrap">{seconds.toFixed(1)}s</span>
                  </div>
                ))}
              </div>
            </div>
          )
        }

      </main >

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .animate-shimmer {
          animation: shimmer 1.5s infinite;
        }
      `}</style>

      {showAISettings && (
        <AISettingsDialog
          settings={aiSettings}
          onChange={setAISettings}
          onClose={() => setShowAISettings(false)}
        />
      )}
    </div >
  );
};

export default App;
