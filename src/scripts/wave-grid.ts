/**
 * Wave Grid background for the landing page: a grid of instanced cubes that
 * ripple like water around the cursor (gentle automatic ripples when idle),
 * with a vignette / RGB-shift post pass. Ported from a React + Three.js
 * component to plain TypeScript and recoloured to the Terra palette.
 *
 * Loaded lazily (dynamic import) so Three.js never delays the first paint.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const MAX_TRAIL = 128;

export interface WaveTheme {
  /** Colour of the resting cubes (and, darker, the background). */
  base: string;
  /** Colour of the wave crests. */
  high: string;
  /** Tone-mapping exposure (lower for the dark theme). */
  exposure: number;
  /** How much the vignette darkens the edges (0–1). */
  vignetteDarken: number;
}

/** Terra palette for the light and dark themes. */
export const TERRA_WAVES: Record<'light' | 'dark', WaveTheme> = {
  light: { base: '#efe7fd', high: '#7c3aed', exposure: 1.5, vignetteDarken: 0.12 },
  dark: { base: '#2a2342', high: '#a98bff', exposure: 1.05, vignetteDarken: 0.5 },
};

const VIGNETTE_RGB_SHIFT_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    shiftAmount: { value: 0.005 },
    vignetteRadius: { value: 0.3 },
    vignetteSoftness: { value: 0.3 },
    darkenAmount: { value: 0.5 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float shiftAmount;
    uniform float vignetteRadius;
    uniform float vignetteSoftness;
    uniform float darkenAmount;
    varying vec2 vUv;
    void main() {
      vec2 center = vec2(0.5);
      float dist = distance(vUv, center);
      float horzQuadrant = sign(vUv.x - center.x);
      float vertQuadrant = sign(vUv.y - center.y);
      float vignetteFactor = smoothstep(vignetteRadius, vignetteRadius + vignetteSoftness, dist);
      float currentShift = shiftAmount * vignetteFactor;
      float r = texture2D(tDiffuse, vUv + vec2(currentShift * horzQuadrant, currentShift * vertQuadrant)).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - vec2(currentShift * horzQuadrant, currentShift * vertQuadrant)).b;
      float darken = 1.0 - vignetteFactor * darkenAmount;
      gl_FragColor = vec4(vec3(r, g, b) * darken, 1.0);
    }
  `,
};

/** Mouse-trail wave displacement, shared by the visible and the depth material. */
function overrideVertexShader(vertexShader: string): string {
  return vertexShader
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
      varying float vHeight;
      attribute vec2 aOffset;
      uniform sampler2D uTrailTexture;
      uniform int       uTrailCount;
      uniform float     uWaveSpeed;
      uniform float     uWaveFreq;
      uniform float     uWaveWidth;
      uniform float     uFadeTime;
      uniform float     uAmplitude;
      uniform float     uJitter;
      uniform float     uMaxHeight;
      vec2 hash2( vec2 p ) {
        p = vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) );
        return fract( sin( p ) * 43758.5453123 ) - 0.5;
      }`,
    )
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
      vHeight = 0.0;
      if ( position.y > 0.0 ) {
        vec2 jitter  = hash2( aOffset ) * uJitter;
        vec2 worldXZ = aOffset + jitter;
        float waveHeight  = 0.0;
        float totalWeight = 0.0;
        for ( int i = 0; i < uTrailCount; i++ ) {
          vec4 td = texture2D( uTrailTexture, vec2( ( float(i) + 0.5 ) / 128.0, 0.5 ) );
          float dist      = length( worldXZ - td.rg );
          float wavefront = uWaveSpeed * td.b;
          float relDist   = dist - wavefront;
          float window = exp( -( relDist * relDist ) / ( uWaveWidth * uWaveWidth ) );
          float fade   = exp( -td.b / uFadeTime );
          float atten  = 1.0 / ( 1.0 + dist * 0.1 );
          float weight = fade * window * atten * td.a;
          waveHeight  += weight * cos( uWaveFreq * relDist );
          totalWeight += weight;
        }
        waveHeight /= max( totalWeight, 1.0 );
        float displacement = clamp( waveHeight * uAmplitude, -uMaxHeight, uMaxHeight );
        transformed.y += displacement;
        vHeight = displacement;
      }`,
    );
}

export interface WaveGridOptions {
  theme: WaveTheme;
  gridSize?: number;
  waveAmplitude?: number;
  waveSpeed?: number;
  waveFrequency?: number;
  waveWidth?: number;
  waveMaxHeight?: number;
  waveJitter?: number;
  /** Gentle random ripples while the cursor is idle. */
  autoAnimate?: boolean;
  /** Follow the pointer (camera sway + ripples). Off for reduced motion. */
  interactive?: boolean;
  vignette?: boolean;
}

export interface WaveGrid {
  setTheme(theme: WaveTheme): void;
  dispose(): void;
}

/** Mount the background into `container` (a canvas is created inside it). */
export function mountWaveGrid(container: HTMLElement, opts: WaveGridOptions): WaveGrid {
  const {
    gridSize = 40,
    waveAmplitude = 0.4,
    waveSpeed = 6.0,
    waveFrequency = 1.2,
    waveWidth = 3.0,
    waveMaxHeight = 0.4,
    waveJitter = 0.2,
    autoAnimate = true,
    interactive = true,
    vignette = true,
  } = opts;
  let theme = opts.theme;

  const canvas = document.createElement('canvas');
  canvas.className = 'wave-canvas';
  container.appendChild(canvas);

  const cubeWidth = 0.8;
  const cubeHeight = 3;
  const gap = 0.01;
  const bounds = gridSize * (cubeWidth + gap);
  const small = window.innerWidth < 720;

  const getSize = () => ({
    width: container.clientWidth || 1,
    height: container.clientHeight || 1,
    pixelRatio: Math.min(window.devicePixelRatio, small ? 1.5 : 2),
  });
  let size = getSize();

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.base).multiplyScalar(0.5);

  // Camera (pointer-driven orbit)
  const alphaRange = Math.PI * 0.03;
  const betaRange = Math.PI * 0.05;
  const mouse = new THREE.Vector2(0, 0);
  const lerpedMouse = new THREE.Vector2(0, 0);
  const camera = new THREE.PerspectiveCamera(40, size.width / size.height, 0.1, 500);
  let cameraRadius = 12;
  const fitCamera = () => {
    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
    const halfBounds = bounds / 2;
    // Cover the whole (rectangular) viewport with cubes, no empty bands.
    cameraRadius = Math.min(halfBounds / Math.tan(verticalHalfFov), halfBounds / Math.tan(horizontalHalfFov)) * 0.9 + cubeHeight * 0.5;
  };
  const positionCamera = (mx: number, my: number) => {
    const alpha = my * alphaRange;
    const beta = mx * betaRange;
    camera.position.set(-cameraRadius * Math.cos(alpha) * Math.sin(beta), cameraRadius * Math.cos(alpha) * Math.cos(beta), cameraRadius * Math.sin(alpha));
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
  };
  fitCamera();
  positionCamera(0, 0);
  scene.add(camera);

  // Lighting
  scene.add(new THREE.AmbientLight('#ffffff', 0.5));
  const keyLight = new THREE.DirectionalLight('#ffffff', 4.0);
  keyLight.position.set(-20, 10, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.radius = 6;
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = 60;
  keyLight.shadow.camera.left = -22;
  keyLight.shadow.camera.right = 22;
  keyLight.shadow.camera.top = 22;
  keyLight.shadow.camera.bottom = -22;
  keyLight.shadow.bias = 0.0001;
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight('#ffffff', 1.0);
  fillLight.position.set(10, 5, -3);
  scene.add(fillLight);

  // Mouse trail (world-space ripple sources)
  const trailData = new Float32Array(MAX_TRAIL * 4);
  const trailTexture = new THREE.DataTexture(trailData, MAX_TRAIL, 1, THREE.RGBAFormat, THREE.FloatType);
  trailTexture.needsUpdate = true;
  const trailUniforms = {
    uTrailTexture: { value: trailTexture },
    uTrailCount: { value: 0 },
    uFadeTime: { value: 2.0 },
    uWaveSpeed: { value: waveSpeed },
    uWaveFreq: { value: waveFrequency },
    uWaveWidth: { value: waveWidth },
    uAmplitude: { value: waveAmplitude },
    uJitter: { value: waveJitter },
    uMaxHeight: { value: waveMaxHeight },
  };
  const colorUniforms = {
    uColorBase: { value: new THREE.Color(theme.base) },
    uColorHigh: { value: new THREE.Color(theme.high) },
  };

  const trail: { x: number; z: number; age: number; distDelta: number }[] = [];
  let lastPoint: { x: number; z: number } | null = null;
  let timeSinceLastMove = 0;
  let randomPointTimer = 0;
  let placingRandom = true;
  const fadeTime = 2.0;
  const trailSpacing = 0.1;

  const rayPlane = new THREE.Mesh(new THREE.PlaneGeometry(bounds, bounds), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false }));
  rayPlane.rotation.x = -Math.PI / 2;
  rayPlane.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();

  // The canvas sits behind the page content, so listen on the window.
  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointerNDC.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    mouse.copy(pointerNDC);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(rayPlane);
    if (!hits.length) return;
    const { x, z } = hits[0].point;
    let distDelta = 0;
    if (lastPoint) {
      const dx = x - lastPoint.x;
      const dz = z - lastPoint.z;
      distDelta = Math.sqrt(dx * dx + dz * dz);
      if (distDelta < trailSpacing) return;
    }
    if (trail.length >= MAX_TRAIL) trail.shift();
    trail.push({ x, z, age: 0, distDelta });
    lastPoint = { x, z };
    timeSinceLastMove = 0;
    placingRandom = false;
    randomPointTimer = 0;
  };
  const onPointerLeave = () => {
    mouse.set(0, 0);
    lastPoint = null;
  };
  if (interactive) {
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
  }

  const addRandomPoint = () => {
    const x = (Math.random() * 0.5 - 0.25) * bounds;
    const z = (Math.random() * 0.5 - 0.25) * bounds;
    if (trail.length >= MAX_TRAIL) trail.shift();
    trail.push({ x, z, age: 0, distDelta: 0.8 + Math.random() * 0.2 });
  };

  const updateTrail = (delta: number) => {
    const expiry = fadeTime * 4;
    for (let i = trail.length - 1; i >= 0; i--) {
      trail[i].age += delta;
      if (trail[i].age > expiry) trail.splice(i, 1);
    }
    timeSinceLastMove += delta;
    if (timeSinceLastMove >= 3.0 && !placingRandom && autoAnimate) {
      placingRandom = true;
      randomPointTimer = 0;
    }
    if (placingRandom && autoAnimate) {
      randomPointTimer += delta;
      if (randomPointTimer >= 1.5) {
        addRandomPoint();
        randomPointTimer = 0;
      }
    }
    const count = Math.min(trail.length, MAX_TRAIL);
    if (count > 0 || trailUniforms.uTrailCount.value > 0) {
      for (let i = 0; i < count; i++) {
        const ti = i * 4;
        trailData[ti] = trail[i].x;
        trailData[ti + 1] = trail[i].z;
        trailData[ti + 2] = trail[i].age;
        trailData[ti + 3] = trail[i].distDelta;
      }
      trailTexture.needsUpdate = true;
      trailUniforms.uTrailCount.value = count;
    }
  };

  // Grid (instanced cubes with the wave shader)
  const count = gridSize * gridSize;
  const geometry = new THREE.BoxGeometry(cubeWidth, cubeHeight, cubeWidth);
  const offsetAttribute = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
  geometry.setAttribute('aOffset', offsetAttribute);

  const material = new THREE.MeshPhongMaterial({ color: 0xffffff });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, trailUniforms, colorUniforms);
    shader.vertexShader = overrideVertexShader(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vHeight;
        uniform vec3  uColorBase;
        uniform vec3  uColorHigh;
        uniform float uMaxHeight;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float t = clamp( vHeight / uMaxHeight, 0.0, 1.0 );
        diffuseColor.rgb = mix( uColorBase, uColorHigh, t );`,
      );
  };
  const depthMaterial = new THREE.MeshDepthMaterial();
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, trailUniforms);
    shader.vertexShader = overrideVertexShader(shader.vertexShader);
  };

  const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
  instancedMesh.customDepthMaterial = depthMaterial;
  instancedMesh.castShadow = true;
  instancedMesh.receiveShadow = true;
  scene.add(instancedMesh);

  const dummy = new THREE.Object3D();
  const spacing = cubeWidth + gap;
  const offset = ((gridSize - 1) * spacing) / 2;
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const index = i * gridSize + j;
      const x = i * spacing - offset;
      const z = j * spacing - offset;
      dummy.position.set(x, 0, z);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(index, dummy.matrix);
      offsetAttribute.setXY(index, x, z);
    }
  }
  instancedMesh.instanceMatrix.needsUpdate = true;
  offsetAttribute.needsUpdate = true;

  // Renderer + post-processing
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, powerPreference: 'low-power' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = theme.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setSize(size.width, size.height, false);
  renderer.setPixelRatio(size.pixelRatio);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const vignettePass = new ShaderPass(VIGNETTE_RGB_SHIFT_SHADER);
  vignettePass.uniforms.darkenAmount.value = theme.vignetteDarken;
  if (vignette) composer.addPass(vignettePass);
  composer.addPass(new OutputPass());
  composer.setSize(size.width, size.height);
  composer.setPixelRatio(size.pixelRatio);

  const applySize = () => {
    size = getSize();
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
    fitCamera();
    positionCamera(lerpedMouse.x, lerpedMouse.y);
    renderer.setSize(size.width, size.height, false);
    renderer.setPixelRatio(size.pixelRatio);
    composer.setSize(size.width, size.height);
    composer.setPixelRatio(size.pixelRatio);
  };
  const resizeObserver = new ResizeObserver(applySize);
  resizeObserver.observe(container);

  // Animation loop (the browser pauses it in background tabs).
  const timer = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const delta = Math.min(timer.getDelta(), 0.1);
    updateTrail(delta);
    lerpedMouse.x += (mouse.x - lerpedMouse.x) * 0.04;
    lerpedMouse.y += (mouse.y - lerpedMouse.y) * 0.04;
    positionCamera(lerpedMouse.x, lerpedMouse.y);
    composer.render();
  });

  return {
    setTheme(next) {
      theme = next;
      colorUniforms.uColorBase.value.set(next.base);
      colorUniforms.uColorHigh.value.set(next.high);
      (scene.background as THREE.Color).set(next.base).multiplyScalar(0.5);
      renderer.toneMappingExposure = next.exposure;
      vignettePass.uniforms.darkenAmount.value = next.vignetteDarken;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      resizeObserver.disconnect();
      geometry.dispose();
      material.dispose();
      depthMaterial.dispose();
      rayPlane.geometry.dispose();
      (rayPlane.material as THREE.Material).dispose();
      trailTexture.dispose();
      composer.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
