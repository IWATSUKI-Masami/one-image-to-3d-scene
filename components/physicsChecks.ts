/**
 * Physical checks of the 3D scene, for Arrange (warnings for the model) and for its
 * evaluation (number of issues before and after):
 * - floating: the model's bottom is above the surface below it (the floor, or the top
 *   of a model it stands over), e.g. a person whose feet do not touch the floor;
 * - sunk: the model's bottom is a little below the top of the model it stands on
 *   (a cup sunk into the table top);
 * - penetration: part of a model's surface is inside another model (tested with rays and
 *   the nearest face on the meshes, accelerated by a bounding volume hierarchy).
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export interface PhysicsIssue {
    kind: 'floating' | 'sunk' | 'penetration';
    /** Index of the other model (support or the model it is inside); -1 = floor */
    other: number;
    /** Gap or depth in world units (floating, sunk), or the fraction of the surface inside (penetration) */
    amount: number;
}

export interface PhysicsResult {
    /** Issues of each model (same order as the input) */
    issues: PhysicsIssue[][];
    /** Number of issues in the scene (each penetrating pair counted once) */
    count: number;
}

/** BVH of each geometry, built once */
const bvhCache = new WeakMap<THREE.BufferGeometry, MeshBVH>();
const bvhOf = (g: THREE.BufferGeometry): MeshBVH => {
    let bvh = bvhCache.get(g);
    if (!bvh) { bvh = new MeshBVH(g); bvhCache.set(g, bvh); }
    return bvh;
};

const meshesOf = (root: THREE.Object3D): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    root.traverse((n) => { const m = n as THREE.Mesh; if (m.isMesh && m.geometry?.attributes.position) out.push(m); });
    return out;
};

/** About `count` points of the model's surface (vertices), in world space */
const samplePoints = (root: THREE.Object3D, count: number): THREE.Vector3[] => {
    const meshes = meshesOf(root);
    const total = meshes.reduce((n, m) => n + m.geometry.attributes.position.count, 0);
    const step = Math.max(1, Math.floor(total / count));
    const pts: THREE.Vector3[] = [];
    for (const m of meshes) {
        const pos = m.geometry.attributes.position;
        for (let i = 0; i < pos.count; i += step) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    }
    return pts;
};

/** Number of surface crossings of a ray from `p` in world direction `dir` */
const crossings = (p: THREE.Vector3, dir: THREE.Vector3, meshes: THREE.Mesh[]): number => {
    let hits = 0;
    const ray = new THREE.Ray();
    const inv = new THREE.Matrix4();
    for (const m of meshes) {
        inv.copy(m.matrixWorld).invert();
        ray.origin.copy(p).applyMatrix4(inv);
        ray.direction.copy(dir).transformDirection(inv);
        hits += bvhOf(m.geometry).raycast(ray, THREE.DoubleSide).length;
    }
    return hits;
};

/** Whether the nearest surface faces away from `p` (p behind the nearest face) */
const behindNearestFace = (p: THREE.Vector3, meshes: THREE.Mesh[]): boolean => {
    let best = Infinity, inside = false;
    const local = new THREE.Vector3(), inv = new THREE.Matrix4();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (const m of meshes) {
        inv.copy(m.matrixWorld).invert();
        local.copy(p).applyMatrix4(inv);
        const hit = bvhOf(m.geometry).closestPointToPoint(local);
        if (!hit || hit.faceIndex === undefined) continue;
        const g = m.geometry, pos = g.attributes.position, idx = g.index;
        const i0 = idx ? idx.getX(hit.faceIndex * 3) : hit.faceIndex * 3;
        const i1 = idx ? idx.getX(hit.faceIndex * 3 + 1) : hit.faceIndex * 3 + 1;
        const i2 = idx ? idx.getX(hit.faceIndex * 3 + 2) : hit.faceIndex * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
        n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
        const point = hit.point.clone().applyMatrix4(m.matrixWorld);
        const d = point.distanceTo(p);
        if (d < best) { best = d; inside = n.dot(point.sub(p)) > 0; }
    }
    return inside;
};

const UP = new THREE.Vector3(0, 1, 0), SIDE = new THREE.Vector3(1, 0, 0);
/**
 * Whether a point is inside a model. Generated meshes often have holes or inner shells,
 * which break a single parity test, so three tests vote: an odd number of surface
 * crossings upwards, an odd number sideways, and the nearest face facing away.
 */
const isInside = (p: THREE.Vector3, meshes: THREE.Mesh[]): boolean => {
    let votes = crossings(p, UP, meshes) % 2 + crossings(p, SIDE, meshes) % 2;
    if (votes === 1) votes += behindNearestFace(p, meshes) ? 1 : 0;
    return votes >= 2;
};

/**
 * Check the models. `tolerance` is the gap or overlap (world units) that still counts as
 * contact; penetrations below `minFraction` of the surface are ignored (models touching).
 */
export const checkPhysics = (models: THREE.Object3D[], floorY: number, tolerance: number, minFraction = 0.02): PhysicsResult => {
    models.forEach(m => m.updateMatrixWorld(true));
    const boxes = models.map(m => new THREE.Box3().setFromObject(m));
    const issues: PhysicsIssue[][] = models.map(() => []);

    // Supports: the highest top below (or just above) the model's bottom, among the models
    // whose horizontal extent contains the model's footprint center; else the floor
    boxes.forEach((b, i) => {
        const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
        let supportTop = floorY, support = -1;
        boxes.forEach((o, j) => {
            if (j === i || cx < o.min.x || cx > o.max.x || cz < o.min.z || cz > o.max.z) return;
            if (o.max.y <= b.min.y + tolerance && o.max.y > supportTop) { supportTop = o.max.y; support = j; }
        });
        const gap = b.min.y - supportTop;
        if (gap > tolerance) issues[i].push({ kind: 'floating', other: support, amount: gap });
        if (b.min.y < floorY - tolerance) issues[i].push({ kind: 'sunk', other: -1, amount: floorY - b.min.y });
        // Sunk into the top of a model it stands on (a small depth; a person's feet far
        // below a table top are under the table, not in it)
        // A model standing on the floor (a seated person's feet under a table) is not sunk
        // into a top above it
        const onFloor = b.min.y <= floorY + tolerance;
        boxes.forEach((o, j) => {
            if (onFloor || j === i || cx < o.min.x || cx > o.max.x || cz < o.min.z || cz > o.max.z) return;
            const depth = o.max.y - b.min.y;
            if (depth > tolerance && depth < (b.max.y - b.min.y) * 0.5 && b.max.y > o.max.y) {
                issues[i].push({ kind: 'sunk', other: j, amount: depth });
            }
        });
    });

    // Penetration: surface points of i inside j, for pairs whose boxes overlap
    const samples = models.map(m => samplePoints(m, 600));
    const meshes = models.map(meshesOf);
    let pairs = 0;
    for (let i = 0; i < models.length; i++) {
        for (let j = 0; j < models.length; j++) {
            if (i === j || !boxes[i].intersectsBox(boxes[j])) continue;
            const pts = samples[i];
            if (pts.length === 0) continue;
            let inside = 0;
            for (const p of pts) if (boxes[j].containsPoint(p) && isInside(p, meshes[j])) inside++;
            const fraction = inside / pts.length;
            if (fraction >= minFraction) {
                issues[i].push({ kind: 'penetration', other: j, amount: fraction });
                if (i < j || !issues[j].some(x => x.kind === 'penetration' && x.other === i)) pairs++;
            }
        }
    }
    const count = issues.reduce((n, list) => n + list.filter(x => x.kind !== 'penetration').length, 0) + pairs;
    return { issues, count };
};
