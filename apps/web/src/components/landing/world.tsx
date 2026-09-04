'use client';

import { Html } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RazorpayMark } from './razorpay-mark';
import { cn } from '@/components/ui/primitives';

/**
 * THE RECLAIM WORLD
 *
 * One WebGL canvas, fixed behind the entire page, holding a single continuous 3D
 * environment. Scrolling does not swap scenes — it flies the camera forward through
 * stations laid out along −Z, so the page reads as one place you move through rather than
 * as a stack of separate visuals.
 *
 *     z ≈    0   hero        the rail, the wordmark, live transaction cards
 *     z ≈  −44   rails       Razorpay below, RECLAIM above
 *     z ≈  −92   loop        the eight stages, walked through
 *     z ≈ −148   infra       the three-tier subsystem map
 *
 * Two rules keep it from becoming a gaming demo. Every object is either a real quantity
 * from the corpus or a real component of the system — nothing is decorative geometry. And
 * all typography is real DOM positioned in 3D (`<Html transform>`), not textures, so it
 * stays crisp, selectable and readable by a screen reader at any zoom.
 *
 * Depth is carried by fog and by per-object distance fades rather than a post-processing
 * pass: a real depth-of-field blur would cost a second render target and, on the elements
 * that matter here, would blur the text.
 */

/* -------------------------------------------------------------------------- */
/* Scroll plumbing                                                             */
/* -------------------------------------------------------------------------- */

interface WorldState {
  /** 0 at the top of the document, 1 at the bottom. */
  progress: React.MutableRefObject<number>;
  /** Pointer in normalised device coordinates, smoothed in the rig. */
  pointer: React.MutableRefObject<{ x: number; y: number }>;
  /**
   * Scroll fractions of the real DOM sections, measured on mount and on resize.
   *
   * Hardcoding these as constants was wrong: the loop station landed on top of the
   * architecture section's own interactive canvas, because the fractions were guesses
   * about a layout that changes whenever the copy does. Measuring keeps the world and the
   * document in step by construction.
   */
  marks: React.MutableRefObject<{ rails: number; loop: number; handoff: number }>;
}

const WorldContext = createContext<WorldState | null>(null);

function useWorld(): WorldState {
  const ctx = useContext(WorldContext);
  if (!ctx) throw new Error('useWorld must be used inside <LandingWorld>');
  return ctx;
}

/** Smoothstep between two scroll marks, for per-station reveals. */
function band(p: number, from: number, to: number): number {
  const t = THREE.MathUtils.clamp((p - from) / Math.max(to - from, 0.0001), 0, 1);
  return t * t * (3 - 2 * t);
}

/* -------------------------------------------------------------------------- */
/* Station geometry                                                            */
/* -------------------------------------------------------------------------- */

const STATION_Z = { hero: 0 } as const;

/**
 * The camera path.
 *
 * With the rails and loop stations removed there is nowhere to fly to, so this is a slow
 * recede: the hero settles back and lifts slightly as the page scrolls away from it, and
 * the whole canvas fades out before the architecture section's own scene begins.
 */
type Marks = { rails: number; loop: number; handoff: number };

function sampleWaypoints(p: number, marks: Marks) {
  const t = THREE.MathUtils.clamp(p / Math.max(marks.handoff, 0.0001), 0, 1);
  const e = t * t * (3 - 2 * t);
  return {
    pos: new THREE.Vector3(0, 0.6 + e * 2.4, 15 + e * 10),
    look: new THREE.Vector3(0, -1.6 + e * 0.9, 0),
  };
}

function FlightRig() {
  const { camera } = useThree();
  const { progress, pointer, marks } = useWorld();
  const smoothed = useRef({ x: 0, y: 0 });
  const lookAt = useRef(new THREE.Vector3(0, -1.6, 0));

  useFrame((_, delta) => {
    const k = 1 - Math.pow(0.0015, Math.min(delta, 0.05));
    const { pos, look } = sampleWaypoints(progress.current, marks.current);

    // Parallax is applied after the waypoint, so it reads as the viewer leaning rather
    // than as the flight path wobbling.
    smoothed.current.x += (pointer.current.x - smoothed.current.x) * k;
    smoothed.current.y += (pointer.current.y - smoothed.current.y) * k;
    // A hint of depth response, not a wobble. At 1.5 the whole scene swam under the
    // cursor and the hero read as unstable rather than as three-dimensional.
    pos.x += smoothed.current.x * 0.3;
    pos.y += -smoothed.current.y * 0.18;

    camera.position.lerp(pos, k);
    lookAt.current.lerp(look, k);
    camera.lookAt(lookAt.current);
  });

  return null;
}

/* -------------------------------------------------------------------------- */
/* Station 1 — the revenue rail                                                */
/* -------------------------------------------------------------------------- */

const RAIL_PARTICLES = 4200;
const RAIL_HALF = 20;
/** Measured on the corpus: ~18% of processed volume fails. */
const LEAK_SHARE = 0.18;
/** Measured recovery rate across resolved cases. */
const RECOVERY_SHARE = 0.578;

const railVertex = /* glsl */ `
  uniform float uTime;
  uniform float uLeak;
  uniform float uRecovery;
  uniform float uPixelRatio;
  uniform float uReveal;

  attribute vec4 aSeed;   // phase, lane, speed, role die
  attribute vec4 aShape;  // size, depth, leak point, arc width

  varying vec3 vTint;
  varying float vGlow;

  const float HALF = ${RAIL_HALF.toFixed(1)};

  void main() {
    float t = fract(aSeed.x + uTime * (0.016 + aSeed.z * 0.045));

    bool leaks = aSeed.w < uLeak;
    bool saved = leaks && (aSeed.w / max(uLeak, 0.0001)) < uRecovery;

    float leakAt = aShape.z;
    float rejoin = min(leakAt + aShape.w, 0.985);

    float x = mix(-HALF, HALF, t);
    float y = -1.6 + aSeed.y * 1.5 + sin(x * 0.3 + uTime * 0.5 + aSeed.x * 6.28) * 0.26;
    float z = aShape.y;

    vec3 tint = vec3(0.42, 0.70, 1.0);
    float glow = 0.34;

    if (leaks && t > leakAt) {
      float fall = (t - leakAt) / max(1.0 - leakAt, 0.0001);
      if (saved) {
        float arc = clamp((t - leakAt) / max(rejoin - leakAt, 0.0001), 0.0, 1.0);
        float dip = sin(arc * 3.14159) * 3.2;
        y -= dip;
        float caught = smoothstep(0.28, 0.62, arc);
        tint = mix(vec3(0.97, 0.50, 0.50), vec3(0.37, 0.92, 0.83), caught);
        glow = 0.45 + caught * 0.75;
      } else {
        y -= fall * fall * 11.0;
        z -= fall * 1.5;
        tint = vec3(0.97, 0.50, 0.50);
        glow = 0.55 * (1.0 - smoothstep(0.15, 0.85, fall));
      }
    }

    vTint = tint;
    vGlow = glow;

    vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aShape.x * (0.55 + glow * 0.55) * uReveal * uPixelRatio * (26.0 / max(-mv.z, 0.001));
  }
`;

const railFragment = /* glsl */ `
  precision mediump float;
  varying vec3 vTint;
  varying float vGlow;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vTint * (0.75 + vGlow * 0.5), pow(core, 3.0) * (0.20 + vGlow * 0.34));
  }
`;

function RevenueRail() {
  const material = useRef<THREE.ShaderMaterial>(null);
  const { progress } = useWorld();

  const buffers = useMemo(() => {
    let s = 0x9e3779b9;
    const rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const seed = new Float32Array(RAIL_PARTICLES * 4);
    const shape = new Float32Array(RAIL_PARTICLES * 4);
    const position = new Float32Array(RAIL_PARTICLES * 3);
    for (let i = 0; i < RAIL_PARTICLES; i += 1) {
      const j = i * 4;
      seed[j] = rand();
      seed[j + 1] = (rand() + rand() + rand()) / 1.5 - 1;
      seed[j + 2] = rand();
      seed[j + 3] = rand();
      shape[j] = 1.8 + rand() * 3.0;
      shape[j + 1] = -1 - rand() * 6;
      shape[j + 2] = 0.3 + rand() * 0.34;
      shape[j + 3] = 0.16 + rand() * 0.2;
    }
    return { seed, shape, position };
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLeak: { value: LEAK_SHARE },
      uRecovery: { value: RECOVERY_SHARE },
      uPixelRatio: { value: 1 },
      uReveal: { value: 0 },
    }),
    [],
  );

  useFrame((state, delta) => {
    const m = material.current;
    if (!m) return;
    m.uniforms.uTime!.value += Math.min(delta, 0.05);
    m.uniforms.uPixelRatio!.value = Math.min(state.gl.getPixelRatio(), 2);
    // Fades out as the camera leaves the hero, so it never fights the stations behind it.
    m.uniforms.uReveal!.value = 1 - band(progress.current, 0.06, 0.2);
  });

  return (
    <points position={[0, 0, STATION_Z.hero]} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[buffers.position, 3]} />
        <bufferAttribute attach="attributes-aSeed" args={[buffers.seed, 4]} />
        <bufferAttribute attach="attributes-aShape" args={[buffers.shape, 4]} />
      </bufferGeometry>
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={railVertex}
        fragmentShader={railFragment}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/**
 * The four transaction cards that hang in the hero.
 *
 * They are the same case at four moments of its life, in pipeline order — failed, scored,
 * authorised, recovered — so the hero states the product's claim without a caption.
 */
const HERO_CARDS: Array<{
  id: string;
  title: string;
  sub: string;
  tone: 'loss' | 'info' | 'mint';
  pos: [number, number, number];
  delay: number;
}> = [
  { id: 'failed', title: '₹2,499', sub: 'Payment failed', tone: 'loss', pos: [7.4, 3.5, -4], delay: 0 },
  { id: 'score', title: '87%', sub: 'Recovery probability', tone: 'info', pos: [7.4, 1.1, -4], delay: 0.12 },
  { id: 'policy', title: 'Approved', sub: '18 guardrails passed', tone: 'mint', pos: [7.4, -1.3, -4], delay: 0.24 },
  { id: 'done', title: '₹2,499', sub: 'Recovered', tone: 'mint', pos: [7.4, -3.7, -4], delay: 0.36 },
];

const CARD_TONE = {
  loss: 'border-loss-500/30 text-loss-400',
  info: 'border-razorpay-400/30 text-razorpay-300',
  mint: 'border-mint-500/30 text-mint-300',
} as const;

function HeroCards() {
  const { progress } = useWorld();
  const group = useRef<THREE.Group>(null);
  const [shown, setShown] = useState(true);

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    g.children.forEach((child, i) => {
      const card = HERO_CARDS[i];
      if (!card) return;
      // Barely moving. The drift is there to keep the column from looking pasted on, not
      // to be noticed — at the previous amplitude four cards bobbing read as clutter.
      child.position.y = card.pos[1] + Math.sin(t * 0.4 + i * 1.7) * 0.05;
    });
    const on = progress.current < 0.12;
    g.visible = on;
    setShown((prev) => (prev === on ? prev : on));
  });

  return (
    <group ref={group} position={[0, 0, STATION_Z.hero]}>
      {(shown ? HERO_CARDS : []).map((card) => (
        <Html
          key={card.id}
          transform
          position={card.pos}
          distanceFactor={11}
          style={{ pointerEvents: 'none' }}
          zIndexRange={[10, 0]}
        >
          <div
            className={cn(
              'w-[176px] rounded-lg border bg-ink-950/[0.96] px-3.5 py-2.5 backdrop-blur-xl',
              'animate-[fadeUp_0.9s_ease-out_both]',
              CARD_TONE[card.tone],
            )}
            style={{ animationDelay: `${card.delay + 0.4}s` }}
          >
            <div className="flex items-center gap-2">
              {card.tone === 'info' ? <RazorpayMark className="h-3" /> : null}
              <span className="text-xl font-light tracking-tight">{card.title}</span>
            </div>
            <p className="mt-1 text-[11px] leading-tight text-silver-400">{card.sub}</p>
          </div>
        </Html>
      ))}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Ambient depth                                                               */
/* -------------------------------------------------------------------------- */

/** A sparse dust field spanning the whole corridor, so travel is legible as travel. */
function Dust() {
  const ref = useRef<THREE.Points>(null);
  const { progress, marks } = useWorld();

  const positions = useMemo(() => {
    const n = 700;
    const arr = new Float32Array(n * 3);
    let s = 0x2545f491;
    const rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < n; i += 1) {
      arr[i * 3] = (rand() - 0.5) * 60;
      arr[i * 3 + 1] = (rand() - 0.5) * 30;
      arr[i * 3 + 2] = -rand() * 190 + 20;
    }
    return arr;
  }, []);

  useFrame((state) => {
    const p = ref.current;
    if (!p) return;
    p.rotation.y = state.clock.elapsedTime * 0.006;
    const material = p.material as THREE.PointsMaterial;
    material.opacity = 0.09 * (1 - band(progress.current, marks.current.handoff - 0.04, marks.current.handoff + 0.06));
  });

  return (
    <points ref={ref} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.045}
        color="#6BB4FF"
        transparent
        opacity={0.09}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        sizeAttenuation
      />
    </points>
  );
}

/* -------------------------------------------------------------------------- */
/* The canvas                                                                  */
/* -------------------------------------------------------------------------- */

function Handoff({ onChange }: { onChange: (visible: boolean) => void }) {
  const { progress, marks } = useWorld();
  const last = useRef(true);

  useFrame(() => {
    const visible = progress.current < marks.current.handoff + 0.02;
    if (visible !== last.current) {
      last.current = visible;
      onChange(visible);
    }
  });

  return null;
}

export function LandingWorld({ className }: { className?: string }) {
  const progress = useRef(0);
  const pointer = useRef({ x: 0, y: 0 });
  const marks = useRef({ rails: 0.26, loop: 0.5, handoff: 0.68 });
  const [enabled, setEnabled] = useState(true);
  const [inFlight, setInFlight] = useState(true);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setEnabled(!query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const measure = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max <= 0) return;
      const at = (id: string) => {
        const el = document.getElementById(id);
        if (!el) return null;
        // Fraction of the scrollable range at which this section reaches mid-viewport.
        return THREE.MathUtils.clamp(
          (el.offsetTop - window.innerHeight * 0.4) / max,
          0,
          1,
        );
      };
      const how = at('how');
      const arch = at('architecture');
      if (how !== null) {
        marks.current.loop = how;
        marks.current.rails = how * 0.52;
      }
      if (arch !== null) marks.current.handoff = arch;
    };

    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.current = max > 0 ? THREE.MathUtils.clamp(window.scrollY / max, 0, 1) : 0;
    };
    const onPointer = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('resize', measure, { passive: true });
    // Measure after layout has settled, then again once fonts and images have landed.
    measure();
    const settle = window.setTimeout(measure, 600);
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('resize', measure);
      window.clearTimeout(settle);
    };
  }, []);

  const value = useMemo<WorldState>(() => ({ progress, pointer, marks }), []);

  if (!enabled) return null;

  return (
    <div
      className={cn(
        'pointer-events-none fixed inset-0 -z-10 transition-opacity duration-700 ease-out',
        inFlight ? 'opacity-100' : 'opacity-0',
        className,
      )}
      aria-hidden
    >
      <WorldContext.Provider value={value}>
        <Canvas
          camera={{ position: [0, 0.6, 15], fov: 48, near: 0.1, far: 320 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        >
          {/* Fog does the depth-of-field work: distant stations dissolve into the ground
              colour instead of stacking up as visual noise behind the near one. */}
          <fog attach="fog" args={['#050507', 26, 120]} />
          <RevenueRail />
          <HeroCards />
          <Dust />
          <FlightRig />
          <Handoff onChange={setInFlight} />
        </Canvas>
      </WorldContext.Provider>
    </div>
  );
}

export { useWorld, band, STATION_Z };
