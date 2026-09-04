'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * THE PAYMENT RAIL
 *
 * The hero visual is the product thesis, not an abstract 3D toy: a rail of payments moves
 * left to right, a share of it fails and drops away, and RECLAIM's interception plane
 * catches part of what fell and returns it to the rail glowing mint. The proportion caught
 * is the recovery rate.
 *
 * All motion lives in the vertex shader. Each particle carries four random seeds and
 * derives its entire trajectory from them plus a clock, so the CPU uploads the buffers
 * once at mount and then does nothing per frame. That is what makes 9,000 particles cheap
 * where the previous CPU implementation had to stop at 1,400.
 *
 * The proportions are not decorative. LEAK_SHARE and RECOVERY_SHARE are set from the
 * corpus's measured failure and recovery rates, so what you watch is the shape of the real
 * portfolio.
 */

const PARTICLE_COUNT = 14000;
const RAIL_LENGTH = 34;
const RAIL_HALF = RAIL_LENGTH / 2;

/** Measured on the seeded corpus: ~15.8% of processed volume fails. */
const LEAK_SHARE = 0.158;
/** Measured recovery rate across resolved cases. */
const RECOVERY_SHARE = 0.605;

// The particle colours live in the shader; this one is for the grid beneath the rail.
const COLOR_FLOW = new THREE.Color('#6BB4FF');

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uLeakShare;
  uniform float uRecoveryShare;
  uniform float uPixelRatio;
  uniform float uIntro;

  // x: phase offset, y: lane, z: speed, w: role die
  attribute vec4 aSeed;
  // x: size, y: depth, z: leak point, w: recovery arc width
  attribute vec4 aShape;

  varying vec3 vTint;
  varying float vGlow;

  const float RAIL_HALF = ${RAIL_HALF.toFixed(1)};

  void main() {
    float speed = 0.018 + aSeed.z * 0.05;
    float t = fract(aSeed.x + uTime * speed);

    bool leaks = aSeed.w < uLeakShare;
    // Reuse the same die for the recovery draw by rescaling it into 0..1 across the
    // leaking population, so the two decisions stay independent without a fifth seed.
    bool recovered = leaks && (aSeed.w / max(uLeakShare, 0.0001)) < uRecoveryShare;

    float leakAt = aShape.z;
    float rejoinAt = min(leakAt + aShape.w, 0.985);

    float x = mix(-RAIL_HALF, RAIL_HALF, t);
    // The rail itself breathes, so the stream never looks like a printed line.
    float y = -3.6 + aSeed.y * 1.35 + sin(x * 0.3 + uTime * 0.55 + aSeed.x * 6.28) * 0.28;
    float z = aShape.y;

    vec3 tint = vec3(0.42, 0.70, 1.0);
    float glow = 0.52;

    if (leaks && t > leakAt) {
      float fall = (t - leakAt) / max(1.0 - leakAt, 0.0001);

      if (recovered) {
        float arc = clamp((t - leakAt) / max(rejoinAt - leakAt, 0.0001), 0.0, 1.0);
        // Down and back up: a parabola that returns exactly to the rail height.
        float dip = sin(arc * 3.14159) * 3.4;
        y -= dip;
        // Colour turns as it is caught, then settles mint once it has rejoined.
        float caught = smoothstep(0.28, 0.62, arc);
        tint = mix(vec3(0.97, 0.50, 0.50), vec3(0.37, 0.92, 0.83), caught);
        glow = 0.42 + caught * 0.72;
        if (arc >= 1.0) {
          tint = vec3(0.37, 0.92, 0.83);
          glow = 1.05;
        }
      } else {
        // Unrecovered revenue: falls away and fades out entirely.
        y -= fall * fall * 12.0;
        z -= fall * 1.6;
        tint = vec3(0.97, 0.50, 0.50);
        glow = 0.55 * (1.0 - smoothstep(0.15, 0.85, fall));
      }
    }

    vTint = tint;
    vGlow = glow;

    vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
    gl_Position = projectionMatrix * mv;

    // Perspective size attenuation, scaled by the intro reveal.
    float size = aShape.x * (0.55 + glow * 0.55) * uIntro;
    gl_PointSize = size * uPixelRatio * (26.0 / max(-mv.z, 0.001));
  }
`;

const fragmentShader = /* glsl */ `
  precision mediump float;

  varying vec3 vTint;
  varying float vGlow;

  void main() {
    // Round sprite with a soft falloff, built from the point coord so there is no texture
    // to load and nothing to go blocky on a high-DPI screen.
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    float core = smoothstep(0.5, 0.0, d);
    float halo = pow(core, 3.0);
    float alpha = halo * (0.42 + vGlow * 0.72);

    gl_FragColor = vec4(vTint * (0.9 + vGlow * 0.8), alpha);
  }
`;

function RailParticles({ intro }: { intro: React.MutableRefObject<number> }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const { viewport } = useThree();

  const { seeds, shapes, positions } = useMemo(() => {
    // Deterministic: the hero looks identical on every load and in every screenshot.
    let state = 0x9e3779b9;
    const random = () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const seeds = new Float32Array(PARTICLE_COUNT * 4);
    const shapes = new Float32Array(PARTICLE_COUNT * 4);
    // Positions are unused by the shader but three.js needs the attribute to size the
    // draw call and to compute a bounding sphere for frustum culling.
    const positions = new Float32Array(PARTICLE_COUNT * 3);

    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      const i4 = i * 4;
      seeds[i4] = random();
      // Lane, biased toward the centre so the rail has a dense core and soft edges.
      seeds[i4 + 1] = (random() + random() + random()) / 1.5 - 1;
      seeds[i4 + 2] = random();
      seeds[i4 + 3] = random();

      shapes[i4] = 2.6 + random() * 5.4;
      shapes[i4 + 1] = -1 - random() * 6;
      // Failures cluster in the middle of the rail so the eye has one place to look.
      shapes[i4 + 2] = 0.3 + random() * 0.34;
      shapes[i4 + 3] = 0.16 + random() * 0.2;
    }

    return { seeds, shapes, positions };
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLeakShare: { value: LEAK_SHARE },
      uRecoveryShare: { value: RECOVERY_SHARE },
      uPixelRatio: { value: 1 },
      uIntro: { value: 0 },
    }),
    [],
  );

  useFrame((state, delta) => {
    const material = materialRef.current;
    if (!material) return;
    material.uniforms.uTime!.value += Math.min(delta, 0.05);
    material.uniforms.uIntro!.value = intro.current;
    material.uniforms.uPixelRatio!.value = Math.min(state.gl.getPixelRatio(), 2);
  });

  // Keep the rail filling the frame on very wide or very narrow viewports.
  const scale = Math.min(1.25, Math.max(0.72, viewport.width / 16));

  return (
    <points scale={[scale, scale, 1]} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aSeed" args={[seeds, 4]} />
        <bufferAttribute attach="attributes-aShape" args={[shapes, 4]} />
      </bufferGeometry>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** A receding grid, for depth and for the sense of sitting on top of infrastructure. */
function RailFloor({ intro }: { intro: React.MutableRefObject<number> }) {
  const ref = useRef<THREE.LineSegments>(null);

  const geometry = useMemo(() => {
    const points: number[] = [];
    const halfW = 26;
    const depth = 30;
    for (let i = 0; i <= 26; i += 1) {
      const z = -depth + (i / 26) * depth;
      points.push(-halfW, 0, z, halfW, 0, z);
    }
    for (let i = 0; i <= 30; i += 1) {
      const x = -halfW + (i / 30) * halfW * 2;
      points.push(x, 0, -depth, x, 0, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return geo;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const material = mesh.material as THREE.LineBasicMaterial;
    material.opacity = 0.05 * intro.current;
    // Drift toward the camera so the infrastructure feels like it is moving under the rail.
    mesh.position.z = ((state.clock.elapsedTime * 0.35) % 1.15) - 1.15;
  });

  return (
    <lineSegments ref={ref} geometry={geometry} position={[0, -6.5, 0]} frustumCulled={false}>
      <lineBasicMaterial color={COLOR_FLOW} transparent opacity={0} depthWrite={false} />
    </lineSegments>
  );
}

/**
 * Camera rig. Parallax follows the pointer, and the whole scene pulls back and dims as the
 * hero scrolls away so it never competes with the copy below it.
 */
function Rig({ intro }: { intro: React.MutableRefObject<number> }) {
  const { camera } = useThree();
  const pointer = useRef({ x: 0, y: 0 });
  const scroll = useRef(0);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    const onScroll = () => {
      scroll.current = Math.min(1, window.scrollY / Math.max(window.innerHeight, 1));
    };
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  useFrame((_, delta) => {
    const k = 1 - Math.pow(0.001, delta);
    const targetX = pointer.current.x * 1.15;
    const targetY = -pointer.current.y * 0.7 + 1.1 + scroll.current * 2.4;
    const targetZ = 13 + scroll.current * 7;

    camera.position.x += (targetX - camera.position.x) * k;
    camera.position.y += (targetY - camera.position.y) * k;
    camera.position.z += (targetZ - camera.position.z) * k;
    camera.lookAt(0, -2.6, 0);

    // Ease the whole scene in once, then hold.
    if (intro.current < 1) intro.current = Math.min(1, intro.current + delta * 0.5);
  });

  return null;
}

export function HeroScene({ className }: { className?: string }) {
  const intro = useRef(0);
  const [enabled, setEnabled] = useState(true);

  // Someone who has asked for reduced motion gets the static gradient instead, which the
  // parent already renders behind this canvas.
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setEnabled(!query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  if (!enabled) return null;

  return (
    <div className={className}>
      <Canvas
        camera={{ position: [0, 1.1, 13], fov: 50 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        // Nothing here reacts to clicks, so let every pointer event fall through to the copy.
        style={{ pointerEvents: 'none' }}
      >
        <fog attach="fog" args={['#050507', 22, 62]} />
        <RailParticles intro={intro} />
        <RailFloor intro={intro} />
        <Rig intro={intro} />
      </Canvas>
    </div>
  );
}
