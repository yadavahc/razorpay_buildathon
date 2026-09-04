'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * THE REVENUE FLOW
 *
 * The hero visual is the product thesis in one image rather than an abstract 3D toy.
 *
 * A stream of revenue moves left to right. A fraction of it falls away — that is the
 * leakage every merchant already has. RECLAIM intercepts part of what fell, and those
 * particles curve back up and rejoin the stream, glowing mint. The proportion that gets
 * caught is the recovery rate.
 *
 * Everything is computed on the CPU into two typed arrays and uploaded once per frame.
 * At this particle count that is cheaper than the per-instance overhead of a shader
 * material with attributes, and it keeps the whole behaviour readable in one function.
 */

const PARTICLE_COUNT = 1400;
const STREAM_LENGTH = 26;
const STREAM_HEIGHT = 3.2;

/** Share of the stream that leaks. Chosen to match the corpus's ~18% failure rate. */
const LEAK_RATE = 0.18;
/** Share of leaked revenue RECLAIM catches. Matches the modelled recovery rate. */
const RECOVERY_RATE = 0.55;

type Phase = 'flowing' | 'leaking' | 'recovering';

interface Particle {
  progress: number;
  speed: number;
  lane: number;
  depth: number;
  phase: Phase;
  /** Where along the stream this particle leaves, if it leaks. */
  leakAt: number;
  /** Where the recovery arc rejoins the stream. */
  rejoinAt: number;
  fallDepth: number;
  size: number;
}

function createParticle(random: () => number, seedProgress = random()): Particle {
  const leaks = random() < LEAK_RATE;
  const recovers = leaks && random() < RECOVERY_RATE;

  return {
    progress: seedProgress,
    speed: 0.035 + random() * 0.05,
    lane: (random() - 0.5) * STREAM_HEIGHT,
    depth: (random() - 0.5) * 3.4,
    phase: 'flowing',
    leakAt: leaks ? 0.32 + random() * 0.3 : Number.POSITIVE_INFINITY,
    rejoinAt: recovers ? 0.78 + random() * 0.14 : Number.POSITIVE_INFINITY,
    fallDepth: 1.6 + random() * 2.6,
    size: 0.7 + random() * 0.8,
  };
}

/** Deterministic RNG so the hero looks identical on every load and in every screenshot. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLOR_FLOW = new THREE.Color('#8b8b99');
const COLOR_LEAK = new THREE.Color('#ef4444');
const COLOR_RECOVER = new THREE.Color('#2dd4bf');

function FlowField({ reducedMotion }: { reducedMotion: boolean }) {
  const pointsRef = useRef<THREE.Points>(null);
  const { viewport } = useThree();

  const { particles, positions, colors, sizes, geometry } = useMemo(() => {
    const random = mulberry32(20260901);
    const list: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => createParticle(random));
    const pos = new Float32Array(PARTICLE_COUNT * 3);
    const col = new Float32Array(PARTICLE_COUNT * 3);
    const siz = new Float32Array(PARTICLE_COUNT);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(siz, 1));

    return { particles: list, positions: pos, colors: col, sizes: siz, geometry: geo };
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const scratch = useMemo(() => new THREE.Color(), []);

  useFrame((_, delta) => {
    const step = reducedMotion ? 0 : Math.min(delta, 0.05);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      p.progress += p.speed * step;

      if (p.progress > 1) {
        // Recycle rather than allocate: the particle budget is fixed for the page's life.
        Object.assign(p, createParticle(mulberry32(i * 7919 + Math.floor(p.progress * 1000)), 0));
        p.progress = 0;
      }

      // Phase transitions along the stream.
      if (p.progress >= p.leakAt && p.phase === 'flowing') p.phase = 'leaking';
      if (p.progress >= p.rejoinAt && p.phase === 'leaking') p.phase = 'recovering';

      const x = (p.progress - 0.5) * STREAM_LENGTH;

      // Gentle sinusoidal drift keeps the stream alive without looking like noise.
      const drift = Math.sin(p.progress * 5.2 + p.lane * 2.1) * 0.22;
      let y = p.lane + drift;

      if (p.phase === 'leaking') {
        // Accelerating fall — leaked revenue does not drift away, it drops.
        const fallen = (p.progress - p.leakAt) / Math.max(0.001, 1 - p.leakAt);
        y -= p.fallDepth * fallen * fallen * 2.4;
      } else if (p.phase === 'recovering') {
        // A recovery arc: caught at the bottom, curved back into the stream.
        const fellFor = p.rejoinAt - p.leakAt;
        const depthAtCatch = p.fallDepth * (fellFor / Math.max(0.001, 1 - p.leakAt)) ** 2 * 2.4;
        const lift = (p.progress - p.rejoinAt) / Math.max(0.001, 1 - p.rejoinAt);
        const eased = 1 - (1 - lift) ** 3;
        y -= depthAtCatch * (1 - eased);
      }

      const index = i * 3;
      positions[index] = x;
      positions[index + 1] = y;
      positions[index + 2] = p.depth;

      const tone =
        p.phase === 'recovering' ? COLOR_RECOVER : p.phase === 'leaking' ? COLOR_LEAK : COLOR_FLOW;

      // Fade in at the source and out at the far edge so particles never pop.
      const edgeFade = Math.min(1, p.progress * 6, (1 - p.progress) * 6);
      const intensity =
        p.phase === 'recovering' ? 1 : p.phase === 'leaking' ? 0.62 : 0.42;

      scratch.copy(tone).multiplyScalar(edgeFade * intensity);
      colors[index] = scratch.r;
      colors[index + 1] = scratch.g;
      colors[index + 2] = scratch.b;

      sizes[i] = p.size * (p.phase === 'recovering' ? 1.7 : 1) * edgeFade;
    }

    geometry.attributes.position!.needsUpdate = true;
    geometry.attributes.color!.needsUpdate = true;
    geometry.attributes.size!.needsUpdate = true;

    if (pointsRef.current && !reducedMotion) {
      pointsRef.current.rotation.y = Math.sin(Date.now() * 0.00008) * 0.05;
    }
  });

  const scale = Math.min(1, viewport.width / 14);

  return (
    <points ref={pointsRef} geometry={geometry} scale={scale}>
      <pointsMaterial
        vertexColors
        size={0.075}
        sizeAttenuation
        transparent
        opacity={0.95}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** A slow parallax tilt driven by the pointer; disabled under reduced motion. */
function ParallaxRig({ enabled }: { enabled: boolean }) {
  const { camera } = useThree();
  const target = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!enabled) return;
    const onMove = (event: PointerEvent): void => {
      target.current.x = (event.clientX / window.innerWidth - 0.5) * 2;
      target.current.y = (event.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [enabled]);

  useFrame(() => {
    if (!enabled) return;
    camera.position.x += (target.current.x * 1.1 - camera.position.x) * 0.03;
    camera.position.y += (-target.current.y * 0.7 - camera.position.y) * 0.03;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

export function RevenueFlow({ className }: { className?: string }) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = (): void => setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    setReady(true);
    return () => query.removeEventListener('change', onChange);
  }, []);

  if (!ready) return <div className={className} aria-hidden />;

  return (
    <div className={className} aria-hidden>
      <Canvas
        camera={{ position: [0, 0, 11], fov: 42 }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        // Render on demand under reduced motion: one frame, then idle.
        frameloop={reducedMotion ? 'demand' : 'always'}
      >
        <FlowField reducedMotion={reducedMotion} />
        <ParallaxRig enabled={!reducedMotion} />
      </Canvas>
    </div>
  );
}
