'use client';

import { Html } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useSound } from './sound';
import { cn } from '@/components/ui/primitives';

/**
 * THE RECLAIM INFRASTRUCTURE MAP
 *
 * An architecture diagram you can walk around rather than a picture of boxes. The nine
 * real subsystems sit on a tilted ring around the decisioning core, grouped into the three
 * layers the system actually separates — intelligence, decisioning, execution — and data
 * flows between them as particles moving along the edges that exist in the code.
 *
 * The claim it exists to make, visually and in one look: Razorpay provides the payment
 * rails; RECLAIM is the intelligence and decisioning layer above them. Razorpay therefore
 * sits in the execution layer where the money actually moves, and everything upstream of
 * it is deciding whether, and how, to move it.
 *
 * Node geometry, edges and particle assignments are all built once. The particles
 * interpolate along their edge inside the vertex shader from a phase and a clock, so the
 * whole network animates without any per-frame CPU work.
 */

export type LayerId = 'intelligence' | 'decisioning' | 'execution';

interface InfraNode {
  id: string;
  label: string;
  short: string;
  layer: LayerId;
  detail: string;
}

export const LAYERS: Record<LayerId, { name: string; blurb: string; hex: string }> = {
  intelligence: {
    name: 'Intelligence',
    blurb: 'Reads the situation. Produces beliefs, never actions.',
    hex: '#6BB4FF',
  },
  decisioning: {
    name: 'Decisioning',
    blurb: 'Prices the options and authorises exactly one.',
    hex: '#5eead4',
  },
  execution: {
    name: 'Execution',
    blurb: 'Moves the money, then proves what happened.',
    hex: '#a1a1ad',
  },
};

/** The pipeline, in the order data actually travels it. */
const NODES: InfraNode[] = [
  {
    id: 'ingestion',
    label: 'Ingestion',
    short: 'Detect',
    layer: 'intelligence',
    detail:
      'Watches four channels where revenue goes missing: declined payments, subscription dunning, abandoned checkouts and overdue invoices. Opens a recovery case the moment money is at risk.',
  },
  {
    id: 'model',
    label: 'Recovery Model',
    short: 'Predict',
    layer: 'intelligence',
    detail:
      'Logistic regression, calibrated on a held-out split. Scores how recoverable a case really is and decomposes every prediction into per-feature contributions, so a decision about money can be explained rather than asserted.',
  },
  {
    id: 'agents',
    label: 'Agents & Copilot',
    short: 'Diagnose',
    layer: 'intelligence',
    detail:
      'Gathers evidence through eleven typed tools and explains the situation in language. It reads and it reasons — it cannot compute an amount, authorise an action, or move money.',
  },
  {
    id: 'ev',
    label: 'Expected Value Engine',
    short: 'Price',
    layer: 'decisioning',
    detail:
      'Prices all six strategies: probability × amount, less the direct cost of the intervention and the modelled cost of annoying the customer. This is the arithmetic that says when chasing money destroys value.',
  },
  {
    id: 'policy',
    label: 'Policy & Guardrails',
    short: 'Authorise',
    layer: 'decisioning',
    detail:
      'Deterministic checks over consent, retry limits, contact caps, quiet hours, duplicates and budget. Ordinary code with no model in the path: the same inputs always give the same verdict, and a check can only ever restrict.',
  },
  {
    id: 'executor',
    label: 'Action Executor',
    short: 'Execute',
    layer: 'execution',
    detail:
      'Claims an idempotency key transactionally before any side effect, then executes under a bounded retry with exponential backoff and a fallback chain that never revisits a strategy.',
  },
  {
    id: 'razorpay',
    label: 'Razorpay',
    short: 'Payment rail',
    layer: 'execution',
    detail:
      'The payment rail. Retries, payment links and captures happen here behind a provider interface, so the same code runs against test-mode APIs or a deterministic simulator — and every result records which one it was.',
  },
  {
    id: 'outcome',
    label: 'Outcome Measurement',
    short: 'Measure',
    layer: 'execution',
    detail:
      'Records what actually happened against the case: recovered, stopped, escalated or failed. Realised outcomes — not model estimates — are what every reported figure is computed from.',
  },
  {
    id: 'audit',
    label: 'Audit Trail',
    short: 'Prove',
    layer: 'execution',
    detail:
      'Append-only and hash-chained: each entry embeds its predecessor’s hash, so the history can be replayed and tampering is detectable rather than merely discouraged.',
  },
];

/** Pipeline edges, plus a spoke from the core to every node. */
const EDGES: Array<[string, string]> = [
  ['ingestion', 'model'],
  ['model', 'agents'],
  ['agents', 'ev'],
  ['ev', 'policy'],
  ['policy', 'executor'],
  ['executor', 'razorpay'],
  ['razorpay', 'outcome'],
  ['outcome', 'audit'],
  ['audit', 'model'],
];

const PARTICLES_PER_EDGE = 30;

/**
 * Three stacked tiers rather than one ring.
 *
 * The layering is the whole argument — intelligence produces beliefs, decisioning
 * authorises, execution moves money — so it has to be legible as height, not merely as
 * hue. Each tier is its own ring at its own altitude, and Razorpay sits on the bottom
 * tier because that is where the rails are: everything above it is deciding whether to
 * use them.
 */
const TIERS: Record<LayerId, { y: number; radius: number }> = {
  intelligence: { y: 3.0, radius: 4.7 },
  decisioning: { y: 0, radius: 4.4 },
  execution: { y: -3.0, radius: 5.8 },
};

function layoutPositions(): Map<string, THREE.Vector3> {
  const map = new Map<string, THREE.Vector3>();

  for (const layerId of Object.keys(TIERS) as LayerId[]) {
    const tier = TIERS[layerId];
    const members = NODES.filter((n) => n.layer === layerId);
    members.forEach((node, i) => {
      // Spread each tier over a full turn, offset so tiers do not stack their nodes
      // directly on top of one another and hide each other from the camera.
      const offset = layerId === 'decisioning' ? Math.PI / 2 : layerId === 'execution' ? 0.4 : 0;
      const angle = -Math.PI / 2 + offset + (i / members.length) * Math.PI * 2;
      map.set(
        node.id,
        new THREE.Vector3(Math.cos(angle) * tier.radius, tier.y, Math.sin(angle) * tier.radius),
      );
    });
  }

  return map;
}

const particleVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;

  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec3 aTint;
  attribute vec2 aPhase; // x: offset, y: speed

  varying vec3 vTint;
  varying float vFade;

  void main() {
    float t = fract(aPhase.x + uTime * aPhase.y);

    vec3 pos = mix(aStart, aEnd, t);
    // Bow each path outward from the centre so parallel edges stay distinguishable and the
    // network reads as volume rather than as a flat wheel.
    vec3 mid = (aStart + aEnd) * 0.5;
    float bow = sin(t * 3.14159);
    pos += normalize(mid) * bow * 0.55;
    pos.y += bow * 0.25;

    // Fade in and out at the endpoints so particles emerge from nodes instead of blinking.
    vFade = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.88, 1.0, t));
    vTint = aTint;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = 3.4 * uPixelRatio * (11.0 / max(-mv.z, 0.001));
  }
`;

const particleFragment = /* glsl */ `
  precision mediump float;
  varying vec3 vTint;
  varying float vFade;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vTint, pow(core, 2.2) * vFade * 0.9);
  }
`;

function DataFlow({ positions }: { positions: Map<string, THREE.Vector3> }) {
  const ref = useRef<THREE.ShaderMaterial>(null);

  const { attrs, count } = useMemo(() => {
    const core = new THREE.Vector3(0, 0, 0);
    const paths: Array<{ a: THREE.Vector3; b: THREE.Vector3; tint: THREE.Color }> = [];

    for (const [from, to] of EDGES) {
      const a = positions.get(from);
      const b = positions.get(to);
      const node = NODES.find((n) => n.id === to);
      if (a && b && node) paths.push({ a, b, tint: new THREE.Color(LAYERS[node.layer].hex) });
    }
    // Spokes: everything reports through the core.
    for (const node of NODES) {
      const p = positions.get(node.id);
      if (p) paths.push({ a: core.clone(), b: p, tint: new THREE.Color(LAYERS[node.layer].hex) });
    }

    const total = paths.length * PARTICLES_PER_EDGE;
    const aStart = new Float32Array(total * 3);
    const aEnd = new Float32Array(total * 3);
    const aTint = new Float32Array(total * 3);
    const aPhase = new Float32Array(total * 2);
    const position = new Float32Array(total * 3);

    let i = 0;
    for (const path of paths) {
      for (let k = 0; k < PARTICLES_PER_EDGE; k += 1) {
        aStart.set([path.a.x, path.a.y, path.a.z], i * 3);
        aEnd.set([path.b.x, path.b.y, path.b.z], i * 3);
        aTint.set([path.tint.r, path.tint.g, path.tint.b], i * 3);
        // Even spacing plus jitter: a steady stream rather than a marching column.
        aPhase[i * 2] = k / PARTICLES_PER_EDGE + Math.random() * 0.02;
        aPhase[i * 2 + 1] = 0.07 + Math.random() * 0.06;
        i += 1;
      }
    }

    return { attrs: { position, aStart, aEnd, aTint, aPhase }, count: total };
  }, [positions]);

  const uniforms = useMemo(
    () => ({ uTime: { value: 0 }, uPixelRatio: { value: 1 } }),
    [],
  );

  useFrame((state, delta) => {
    const material = ref.current;
    if (!material) return;
    material.uniforms.uTime!.value += Math.min(delta, 0.05);
    material.uniforms.uPixelRatio!.value = Math.min(state.gl.getPixelRatio(), 2);
  });

  return (
    <points frustumCulled={false} key={count}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[attrs.position, 3]} />
        <bufferAttribute attach="attributes-aStart" args={[attrs.aStart, 3]} />
        <bufferAttribute attach="attributes-aEnd" args={[attrs.aEnd, 3]} />
        <bufferAttribute attach="attributes-aTint" args={[attrs.aTint, 3]} />
        <bufferAttribute attach="attributes-aPhase" args={[attrs.aPhase, 2]} />
      </bufferGeometry>
      <shaderMaterial
        ref={ref}
        uniforms={uniforms}
        vertexShader={particleVertex}
        fragmentShader={particleFragment}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** The static wiring beneath the particles, so the topology reads even when still. */
function Connections({ positions }: { positions: Map<string, THREE.Vector3> }) {
  const geometry = useMemo(() => {
    const pts: number[] = [];
    const push = (a: THREE.Vector3, b: THREE.Vector3) => {
      // Match the particle bow so the wire and the flow occupy the same path.
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = mid.clone().normalize();
      for (let s = 0; s < 24; s += 1) {
        for (const t of [s / 24, (s + 1) / 24]) {
          const p = a.clone().lerp(b, t);
          const bow = Math.sin(t * Math.PI);
          p.addScaledVector(dir, bow * 0.55);
          p.y += bow * 0.25;
          pts.push(p.x, p.y, p.z);
        }
      }
    };

    const core = new THREE.Vector3(0, 0, 0);
    for (const [from, to] of EDGES) {
      const a = positions.get(from);
      const b = positions.get(to);
      if (a && b) push(a, b);
    }
    for (const node of NODES) {
      const p = positions.get(node.id);
      if (p) push(core, p);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return geo;
  }, [positions]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial
        color="#6BB4FF"
        transparent
        opacity={0.09}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </lineSegments>
  );
}

/** A faint disc per tier, so the three layers read as altitudes rather than as hues. */
function TierRings() {
  const rings = useMemo(
    () =>
      (Object.keys(TIERS) as LayerId[]).map((id) => ({
        id,
        y: TIERS[id].y,
        radius: TIERS[id].radius,
        hex: LAYERS[id].hex,
      })),
    [],
  );

  return (
    <>
      {rings.map((ring) => (
        <group key={ring.id} position={[0, ring.y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh>
            <ringGeometry args={[ring.radius - 0.035, ring.radius + 0.035, 96]} />
            <meshBasicMaterial
              color={ring.hex}
              transparent
              opacity={0.22}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          <mesh>
            <circleGeometry args={[ring.radius, 64]} />
            <meshBasicMaterial
              color={ring.hex}
              transparent
              opacity={0.018}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        </group>
      ))}
    </>
  );
}

function CoreNode({
  active,
  occluderRef,
}: {
  active: boolean;
  occluderRef: React.MutableRefObject<THREE.Mesh | null>;
}) {
  const ref = useRef<THREE.Group>(null);

  useFrame((state) => {
    const group = ref.current;
    if (!group) return;
    const t = state.clock.elapsedTime;
    group.rotation.y = t * 0.25;
    const pulse = 1 + Math.sin(t * 1.4) * 0.035;
    group.scale.setScalar(pulse * (active ? 1.06 : 1));
  });

  return (
    <group ref={ref}>
      <mesh>
        <icosahedronGeometry args={[0.9, 1]} />
        <meshBasicMaterial color="#5eead4" wireframe transparent opacity={0.55} />
      </mesh>
      {/* Solid inner body, and the mesh node labels are occlusion-tested against: a label
          for a subsystem currently behind the core must not read through it. */}
      <mesh ref={occluderRef}>
        <icosahedronGeometry args={[0.6, 2]} />
        <meshBasicMaterial color="#2dd4bf" transparent opacity={0.16} />
      </mesh>
      <mesh>
        <sphereGeometry args={[1.35, 24, 24]} />
        <meshBasicMaterial
          color="#2dd4bf"
          transparent
          opacity={0.03}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function NodeMesh({
  node,
  position,
  hovered,
  onHover,
  occluderRef,
}: {
  node: InfraNode;
  position: THREE.Vector3;
  hovered: boolean;
  onHover: (id: string | null) => void;
  occluderRef: React.MutableRefObject<THREE.Mesh | null>;
}) {
  const ref = useRef<THREE.Group>(null);
  const color = LAYERS[node.layer].hex;

  useFrame((state, delta) => {
    const group = ref.current;
    if (!group) return;
    const target = hovered ? 1.55 : 1;
    const k = 1 - Math.pow(0.002, delta);
    group.scale.setScalar(group.scale.x + (target - group.scale.x) * k);
    group.rotation.y += delta * (hovered ? 0.7 : 0.22);
    // A slow bob keeps the network feeling alive rather than diagrammed.
    group.position.y =
      position.y + Math.sin(state.clock.elapsedTime * 0.8 + position.x) * 0.075;
  });

  return (
    <group ref={ref} position={position}>
      <mesh>
        <octahedronGeometry args={[0.46, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={hovered ? 0.95 : 0.6} />
      </mesh>
      <mesh>
        <octahedronGeometry args={[0.3, 0]} />
        <meshBasicMaterial color={color} transparent opacity={hovered ? 0.55 : 0.22} />
      </mesh>
      {/* Additive halo only. The previous non-additive sphere read as a grey blob against
          the near-black ground instead of as light. */}
      <mesh>
        <sphereGeometry args={[0.8, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={hovered ? 0.085 : 0.028}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* The name stays on screen. An architecture map you have to hover to read is a
          guessing game, so hover is reserved for the explanation, not the identity. */}
      <Html
        center
        position={[0, 0.92, 0]}
        zIndexRange={[20, 0]}
        distanceFactor={14}
        occlude={occluderRef as unknown as React.RefObject<THREE.Object3D>[]}
        // Without this the label's own wrapper sits over the node and steals the pointer,
        // which fires pointerOut on the mesh the instant the label appears — the node stays
        // visually hovered while the detail panel flickers straight back to idle.
        style={{ pointerEvents: 'none' }}
      >
        <div
          className="pointer-events-none select-none whitespace-nowrap text-center"
          style={{ transform: 'translateY(-2px)' }}
        >
          <div
            className="text-[10px] font-medium leading-tight transition-colors duration-300"
            style={{ color: hovered ? color : 'rgba(226,226,232,0.82)' }}
          >
            {node.label}
          </div>
          <div className="text-[8px] uppercase leading-tight tracking-[0.14em] text-silver-600">
            {node.short}
          </div>
        </div>
      </Html>

      {/* Invisible, generous hit target: the visible geometry is far too small to hover. */}
      <mesh
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(node.id);
        }}
        onPointerOut={() => onHover(null)}
      >
        <sphereGeometry args={[1.05, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Slow orbit plus pointer parallax, paused while a node is being inspected. */
function MapRig({ frozen }: { frozen: boolean }) {
  const { camera } = useThree();
  const angle = useRef(0);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useFrame((_, delta) => {
    if (!frozen) angle.current += delta * 0.08;
    const r = 17.5;
    const targetX = Math.sin(angle.current) * r + pointer.current.x * 1.1;
    const targetZ = Math.cos(angle.current) * r;
    const targetY = 3.4 - pointer.current.y * 0.9;

    const k = 1 - Math.pow(0.004, delta);
    camera.position.x += (targetX - camera.position.x) * k;
    camera.position.y += (targetY - camera.position.y) * k;
    camera.position.z += (targetZ - camera.position.z) * k;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

export function InfrastructureMap({ className }: { className?: string }) {
  const positions = useMemo(layoutPositions, []);
  const occluderRef = useRef<THREE.Mesh | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const { play } = useSound();
  const lastHover = useRef<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setEnabled(!query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  // One tick per newly hovered node, never on the way out.
  useEffect(() => {
    if (hovered && hovered !== lastHover.current) play('hover');
    lastHover.current = hovered;
  }, [hovered, play]);

  const active = hovered ? NODES.find((n) => n.id === hovered) ?? null : null;

  if (!enabled) {
    return <StaticFallback className={className} />;
  }

  return (
    <div className={cn('relative', className)}>
      <Canvas
        camera={{ position: [0, 3.4, 17.5], fov: 46 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      >
        <TierRings />
        <Connections positions={positions} />
        <DataFlow positions={positions} />
        <CoreNode active={hovered === null} occluderRef={occluderRef} />
        {NODES.map((node) => (
          <NodeMesh
            key={node.id}
            node={node}
            position={positions.get(node.id)!}
            hovered={hovered === node.id}
            onHover={setHovered}
            occluderRef={occluderRef}
          />
        ))}
        <MapRig frozen={hovered !== null} />
      </Canvas>

      {/* Overlay chrome. Kept in the DOM rather than in the scene so the typography is
          real text: selectable, translatable, and crisp at every zoom level. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="label-eyebrow">RECLAIM decisioning engine</p>
            <p className="mt-1.5 max-w-xs text-2xs leading-relaxed text-silver-500">
              Nine subsystems, in the order data travels them. Hover any node.
            </p>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
            {(Object.keys(LAYERS) as LayerId[]).map((id) => (
              <li key={id} className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: LAYERS[id].hex }}
                />
                <span className="text-2xs uppercase tracking-[0.14em] text-silver-500">
                  {LAYERS[id].name}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-end justify-between gap-4">
          <AnimatePresence mode="wait">
            {active ? (
              <motion.div
                key={active.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="max-w-md rounded-xl border border-white/10 bg-ink-900/90 p-4 backdrop-blur-xl"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: LAYERS[active.layer].hex }}
                  />
                  <span className="text-xs font-medium text-silver-100">{active.label}</span>
                  <span className="text-2xs uppercase tracking-[0.14em] text-silver-600">
                    {LAYERS[active.layer].name}
                  </span>
                </div>
                <p className="mt-2 text-2xs leading-relaxed text-silver-400">{active.detail}</p>
              </motion.div>
            ) : (
              <motion.p
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="max-w-sm text-2xs leading-relaxed text-silver-600"
              >
                Razorpay provides the payment rails. RECLAIM is the intelligence and decisioning
                layer above them.
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/**
 * Reduced-motion fallback. Someone who asked for less motion still deserves the topology,
 * so they get the same nine subsystems and the same layering as a static list.
 */
function StaticFallback({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-xl border border-white/[0.07] bg-white/[0.02] p-6', className)}>
      <p className="label-eyebrow">RECLAIM decisioning engine</p>
      <div className="mt-5 grid gap-5 sm:grid-cols-3">
        {(Object.keys(LAYERS) as LayerId[]).map((layerId) => (
          <div key={layerId}>
            <div className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: LAYERS[layerId].hex }}
              />
              <span className="text-2xs uppercase tracking-[0.14em] text-silver-400">
                {LAYERS[layerId].name}
              </span>
            </div>
            <ul className="mt-3 space-y-2">
              {NODES.filter((n) => n.layer === layerId).map((n) => (
                <li key={n.id}>
                  <p className="text-xs text-silver-200">{n.label}</p>
                  <p className="mt-1 text-2xs leading-relaxed text-silver-600">{n.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
