import * as THREE from 'three';

/**
 * Remove small mesh fragments that lie far from the main body.
 *
 * Generated models can contain tiny stray fragments (e.g. Hunyuan3D-2.1 leaves
 * pieces of a few triangles near the walls of its generation volume). They are
 * nearly invisible but stretch the bounding box, which is used both for the
 * "Bounding Box View" and for scaling and placing the model in the 3D scene.
 *
 * Triangles are grouped into connected parts (vertices that share a position
 * are merged, since texture seams split them). Parts holding the bulk of the
 * surface form the main body; a smaller part is kept only if it is large or
 * close to the main body, so separate but nearby parts (a saucer, petals) stay.
 *
 * Returns the number of removed triangles.
 */

/** Surface share that defines the main body */
const MAIN_AREA_SHARE = 0.9;
/** Parts with at least this share of the surface are always kept */
const KEEP_AREA_SHARE = 0.01;
/** Smaller parts are kept within this distance of the main body (relative to its diagonal) */
const NEAR_DISTANCE = 0.05;

interface Part {
  area: number;
  box: THREE.Box3;
  triangles: number[];
}

const findParts = (geometry: THREE.BufferGeometry): { parts: Part[]; index: ArrayLike<number> } | null => {
  const position = geometry.getAttribute('position');
  if (!position) return null;
  const vertexCount = position.count;
  const index: ArrayLike<number> = geometry.index
    ? geometry.index.array
    : Array.from({ length: vertexCount }, (_, i) => i);
  const triangleCount = Math.floor(index.length / 3);
  if (triangleCount === 0) return null;

  // Merge vertices at the same position (texture seams duplicate them)
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3()).length() || 1;
  const step = size * 1e-5;
  const weldId = new Int32Array(vertexCount);
  const keys = new Map<string, number>();
  for (let i = 0; i < vertexCount; i++) {
    const key = `${Math.round(position.getX(i) / step)},${Math.round(position.getY(i) / step)},${Math.round(position.getZ(i) / step)}`;
    let id = keys.get(key);
    if (id === undefined) {
      id = keys.size;
      keys.set(key, id);
    }
    weldId[i] = id;
  }

  // Union-find over the merged vertices of each triangle
  const parent = new Int32Array(keys.size).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let t = 0; t < triangleCount; t++) {
    const a = find(weldId[index[3 * t]]);
    const b = find(weldId[index[3 * t + 1]]);
    const c = find(weldId[index[3 * t + 2]]);
    parent[b] = a;
    parent[find(c)] = a;
  }

  const parts = new Map<number, Part>();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t < triangleCount; t++) {
    const i0 = index[3 * t], i1 = index[3 * t + 1], i2 = index[3 * t + 2];
    const root = find(weldId[i0]);
    let part = parts.get(root);
    if (!part) {
      part = { area: 0, box: new THREE.Box3(), triangles: [] };
      parts.set(root, part);
    }
    va.fromBufferAttribute(position, i0);
    vb.fromBufferAttribute(position, i1);
    vc.fromBufferAttribute(position, i2);
    part.area += ab.subVectors(vb, va).cross(ac.subVectors(vc, va)).length() / 2;
    part.box.expandByPoint(va).expandByPoint(vb).expandByPoint(vc);
    part.triangles.push(t);
  }
  return { parts: [...parts.values()], index };
};

/** Distance between two boxes (0 if they overlap) */
const boxGap = (a: THREE.Box3, b: THREE.Box3): number => {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
  const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
  return Math.hypot(dx, dy, dz);
};

/** Decide which parts to keep */
const selectParts = (parts: Part[]): Set<Part> => {
  const total = parts.reduce((sum, p) => sum + p.area, 0);
  const sorted = [...parts].sort((a, b) => b.area - a.area);
  const keep = new Set<Part>();
  const main = new THREE.Box3();
  let covered = 0;
  for (const part of sorted) {
    if (covered >= MAIN_AREA_SHARE * total) break;
    keep.add(part);
    main.union(part.box);
    covered += part.area;
  }
  // Add nearby or large parts; repeat while the main body grows
  let changed = true;
  while (changed) {
    changed = false;
    const near = main.getSize(new THREE.Vector3()).length() * NEAR_DISTANCE;
    for (const part of sorted) {
      if (keep.has(part)) continue;
      if (part.area >= KEEP_AREA_SHARE * total || boxGap(part.box, main) <= near) {
        keep.add(part);
        main.union(part.box);
        changed = true;
      }
    }
  }
  return keep;
};

/** Rebuild the geometry with only the given triangles; unused vertices are dropped */
const keepTriangles = (geometry: THREE.BufferGeometry, index: ArrayLike<number>, triangles: number[]) => {
  const remap = new Map<number, number>();
  const newIndex: number[] = [];
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const v = index[3 * t + k];
      let n = remap.get(v);
      if (n === undefined) {
        n = remap.size;
        remap.set(v, n);
      }
      newIndex.push(n);
    }
  }
  const order = [...remap.keys()];
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    const ArrayType = (attr.array as any).constructor as new (n: number) => THREE.TypedArray;
    const size = attr.itemSize;
    const array = new ArrayType(order.length * size);
    const getters = [attr.getX, attr.getY, attr.getZ, attr.getW].slice(0, size);
    order.forEach((v, i) => getters.forEach((get, c) => { array[i * size + c] = get.call(attr, v); }));
    geometry.setAttribute(name, new THREE.BufferAttribute(array, size, attr.normalized));
  }
  geometry.setIndex(newIndex);
  geometry.morphAttributes = {};
  geometry.clearGroups();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
};

export const removeStrayFragments = (root: THREE.Object3D): number => {
  let removed = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || (mesh as any).isSkinnedMesh) return;
    // Multi-material groups would need per-group handling; leave such meshes as they are
    if (mesh.geometry.groups.length > 1) return;
    const found = findParts(mesh.geometry);
    if (!found || found.parts.length < 2) return;
    const keep = selectParts(found.parts);
    if (keep.size === found.parts.length) return;
    const triangles = found.parts.filter(p => keep.has(p)).flatMap(p => p.triangles).sort((a, b) => a - b);
    removed += found.index.length / 3 - triangles.length;
    keepTriangles(mesh.geometry, found.index, triangles);
  });
  return removed;
};
