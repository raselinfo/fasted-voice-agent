// WebGL2 audio-reactive orb — extracted from orb-prototypes/orb.html
// Usage: import { createOrb } from '/orb.js';

const P = {
  fbm: 0.05, noise: 0.15, ring: 0.1,
  noiseAmp: 0.15, fbmAmp: 0.65, qWarp: 2.5, extraBlend: 0.3,
  cumPlosFbm: 0.3, cumPlosNoise: 2.0,
  onsetThresh: 0.02, onsetSens: 10, onsetRiseCap: 0.02, onsetDecay: 0.9,
  plosiveShape: 0.4, onsetSpeed: 3, onsetWarp: 8,
  warpAttack: 0.15, warpDecay: 0.05,
};

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const UNIFORM_NAMES = [
  "uTime", "uVolume", "uPlosive", "uCumPlosive", "uAudio", "uCumAudio",
  "uAudioTime", "uWarp", "uCoeffFbm", "uCoeffNoise", "uCoeffRing",
  "uNoiseAmp", "uFbmAmp", "uQWarp", "uExtraBlend", "uCumPlosFbm", "uCumPlosNoise",
];

const QUALITY_PROFILES = {
  baseline: {
    dprCap: Infinity,
    qOctaves: 5,
    detailOctaves: 5,
    extraOctaves: 5,
    finalOctaves: 5,
    earlyMask: false,
    filmGrain: true,
    simpleRingNoise: false,
  },
  optimized: {
    dprCap: Infinity,
    qOctaves: 5,
    detailOctaves: 4,
    extraOctaves: 3,
    finalOctaves: 5,
    earlyMask: true,
    filmGrain: true,
    simpleRingNoise: true,
  },
};

function buildFragmentShader(profile) {
  return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform float uTime;
uniform float uVolume;
uniform float uPlosive;
uniform float uCumPlosive;
uniform vec4 uAudio;
uniform vec4 uCumAudio;
uniform float uAudioTime;
uniform float uWarp;
uniform float uCoeffFbm;
uniform float uCoeffNoise;
uniform float uCoeffRing;
uniform float uNoiseAmp;
uniform float uFbmAmp;
uniform float uExtraBlend;
uniform float uCumPlosFbm;
uniform float uCumPlosNoise;
uniform float uQWarp;

vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 permute(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float random(vec2 st) {
  return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise2d(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = random(i);
  float b = random(i + vec2(1.0, 0.0));
  float c = random(i + vec2(0.0, 1.0));
  float d = random(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm(vec2 st, int octaves) {
  float v = 0.0, a = 0.5;
  vec2 shift = vec2(100.0);
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    v += a * noise2d(st);
    st = rot * st * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}

vec2 sphereUV(vec2 uv, float scale, float power) {
  vec2 centered = (uv - 0.5) * 2.0;
  float d = sqrt(1.0 - clamp(dot(centered, centered), 0.0, 1.0));
  d = pow(d, power);
  vec2 uv_scale = 1.0 / vec2(scale);
  centered /= (vec2(d) + vec2(1.0)) * uv_scale;
  return (centered + 1.0) * 0.5;
}

float filmGrain(vec2 uv, float t) {
  return length(fract(sin(vec2(dot(uv, vec2(2127.1, 81.17)), dot(uv, vec2(1269.5, 283.37)))) * 43758.5453));
}

vec3 palette(float t) {
  vec3 a = vec3(0.3, 0.5, 0.6);
  vec3 b = vec3(0.3, 0.3, 0.3);
  vec3 c = vec3(1.0, 1.0, 1.0);
  vec3 d = vec3(0.00, 0.15, 0.20);
  return a + b * cos(6.28318 * (c * t + d));
}

void main() {
  float dist = length(vUv - 0.5) * 2.0;
  ${profile.earlyMask ? "if (dist > 0.96) { outColor = vec4(0.0); return; }" : ""}
  float warpScale = (uWarp - 1.5) / 8.0;
  vec2 uv = sphereUV(vUv, 0.9 - warpScale * 0.08, 1.1);

  float t = uAudioTime * uCoeffFbm + uCumPlosive * uCumPlosFbm;

  float baseWarp = 1.5;
  float extraWarp = uWarp - baseWarp;

  vec2 q = vec2(
    fbm(uv * 3.25 + vec2(t * 0.7, t * 0.5), ${profile.qOctaves}),
    fbm(uv * 3.25 + vec2(1.0) + vec2(t * 0.35, -t * 0.6), ${profile.qOctaves})
  );
  float outerWarp = uWarp;
  vec2 r = vec2(
    fbm(uv * 3.25 + q * uQWarp + vec2(91.3, 0.55) + vec2(t * 0.5, t * 0.4), ${profile.detailOctaves}),
    fbm(uv * 3.25 + q * uQWarp - vec2(45.33, 1.2) + vec2(-t * 0.35, t * 0.45), ${profile.detailOctaves})
  );
  vec2 rExtra = vec2(
    fbm(uv * 4.5 + q * 2.0 + vec2(23.7, 8.1) + vec2(t * 0.6, t * 0.3), ${profile.extraOctaves}),
    fbm(uv * 4.5 + q * 2.0 - vec2(17.5, 3.9) + vec2(-t * 0.4, t * 0.5), ${profile.extraOctaves})
  );
  vec2 rCombined = r + rExtra * extraWarp * uExtraBlend;
  float f = fbm(uv * 3.25 + rCombined * outerWarp, ${profile.finalOctaves});
  float ff = mix(0.8, 0.66, clamp(f * f * 2.75, 0.0, 1.0));
  ff = mix(ff, 0.0, clamp(length(q), 0.0, 1.0));
  ff = mix(ff, 1.0, clamp(length(r.x), 0.0, 1.0));

  float noisePhase = uAudioTime * uCoeffNoise + uCumPlosive * uCumPlosNoise;
  float nx = snoise(vec3(vUv * 0.65, noisePhase));
  float ny = snoise(vec3(vUv * 0.65 + 54.0, noisePhase * 1.3));
  float audioNoiseBoost = (uWarp - 1.5) / 8.0;
  uv += vec2(nx, ny) * (uNoiseAmp + audioNoiseBoost * 0.3);
  uv += vec2(ff - 0.5) * uFbmAmp;

  float colorPhase = length(uv - 0.5) * 1.5 + f * 0.5
                   + uTime * 0.02 + uCumAudio.y * 0.05;
  vec3 color = palette(colorPhase);

  vec2 ringUv = (vUv - 0.5) * 2.0 * 0.75;
  ringUv.x += 1.0 + uCumAudio.y * 0.3;
  float ang = atan(ringUv.y, ringUv.x);
  float len = length(ringUv);
  float ringTime = -uAudioTime * uCoeffRing;
  float n0 = ${profile.simpleRingNoise
    ? "noise2d(ringUv * 1.1 + vec2(ringTime * 0.15, ringTime * 0.08))"
    : "snoise(vec3(ringUv * 0.65, ringTime * 0.5)) * 0.5 + 0.5"};
  float cl = cos(ang + ringTime * 2.0) * 0.5 + 0.5;
  float v2 = smoothstep(1.0, mix(0.25, 1.0, n0 * 0.5), len);
  float v3 = pow(smoothstep(0.25, mix(0.25, 1.0, n0 * 0.75), len), 2.0);
  cl = cl * v2 * v3;
  cl = clamp(pow(cl * min(uPlosive * 3.0 + uVolume * 2.0, 1.0), 3.0), 0.0, 1.0);
  color += vec3(cl) * 0.25;

  ${profile.filmGrain ? "color *= mix(vec3(1.0), vec3(filmGrain(vUv, uTime)), 0.05);" : ""}
  color = (1.0 + 0.15) * color;

  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(lum), color, 1.0);
  color = clamp(color, 0.0, 1.0);

  float edgeExpand = pow(warpScale, 0.4) * 0.12;
  float alpha = 1.0 - smoothstep(0.82 + edgeExpand, 0.83 + edgeExpand, dist);
  outColor = vec4(color * alpha, alpha);
}
`;
}

const ATTACK = 0.4;
const DECAY = 0.08;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error("Shader compile error: " + info);
  }
  return s;
}

function createProgramBundle(gl, fragSource) {
  const prog = gl.createProgram();
  const vert = compile(gl, gl.VERTEX_SHADER, VERT);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSource);
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.bindAttribLocation(prog, 0, "aPosition");
  gl.linkProgram(prog);
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error("Shader link error: " + gl.getProgramInfoLog(prog));
  }

  gl.useProgram(prog);
  const uniforms = {};
  for (const name of UNIFORM_NAMES) {
    uniforms[name] = gl.getUniformLocation(prog, name);
  }

  return { prog, uniforms };
}

/**
 * Create an audio-reactive WebGL2 orb on the given canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {AnalyserNode|null} analyserNode
 * @param {{ qualityMode?: "baseline" | "optimized" }=} options
 * @returns {{ setAnalyser(node: AnalyserNode|null): void, setQualityMode(mode: "baseline" | "optimized"): void, getQualityMode(): "baseline" | "optimized", destroy(): void }}
 */
export function createOrb(canvas, analyserNode = null, options = {}) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
  });
  if (!gl) {
    throw new Error("WebGL2 not supported");
  }

  let qualityMode = options.qualityMode === "optimized" ? "optimized" : "baseline";

  // Fullscreen quad VAO
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const programs = {
    baseline: createProgramBundle(gl, buildFragmentShader(QUALITY_PROFILES.baseline)),
    optimized: createProgramBundle(gl, buildFragmentShader(QUALITY_PROFILES.optimized)),
  };

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // Audio state
  let analyser = analyserNode;
  let freqData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const audioLevels = new Float32Array(4);
  let rawVol = 0;
  let prevRawVol = 0;
  const cumulativeAudio = new Float32Array(4);
  let audioTime = 0;
  let smoothWarp = 1.5;
  let plosiveLevel = 0;
  let cumulativePlosive = 0;

  // Interaction state
  let hovered = false;
  let hoverBlend = 0; // 0..1 smooth
  let clickPulse = 0; // decays to 0

  function updateAudio(dt) {
    // Smooth hover blend (ease in fast, ease out slower)
    const hoverTarget = hovered ? 1 : 0;
    const hoverRate = hoverTarget > hoverBlend ? 0.12 : 0.04;
    hoverBlend += (hoverTarget - hoverBlend) * hoverRate;

    // Decay click pulse
    clickPulse *= 0.92;
    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      const n = freqData.length;
      const band = Math.floor(n / 4);

      let rawSum = 0;
      for (let i = 0; i < n; i++) rawSum += freqData[i];
      rawVol = rawSum / n / 255;

      for (let b = 0; b < 4; b++) {
        let sum = 0;
        for (let i = b * band; i < (b + 1) * band; i++) sum += freqData[i];
        const target = sum / band / 255;
        const speed = target > audioLevels[b] ? ATTACK : DECAY;
        audioLevels[b] += (target - audioLevels[b]) * speed;
      }
    } else {
      // Idle ambient sine-wave fallback, amplified by hover
      const t = performance.now() / 1000;
      const h = 1 + hoverBlend * 1.5; // hover amplifies breathing
      audioLevels[0] = (0.05 + 0.03 * Math.sin(t * 0.7)) * h;
      audioLevels[1] = (0.04 + 0.02 * Math.sin(t * 0.5 + 1)) * h;
      audioLevels[2] = (0.03 + 0.02 * Math.sin(t * 0.3 + 2)) * h;
      audioLevels[3] = (0.02 + 0.01 * Math.sin(t * 0.4 + 3)) * h;
      rawVol = 0;
    }

    for (let i = 0; i < 4; i++) cumulativeAudio[i] += audioLevels[i] * dt;

    // Onset detection from raw volume
    const delta = rawVol - prevRawVol;
    if (delta > P.onsetThresh) {
      plosiveLevel = Math.min(plosiveLevel + Math.min(delta * P.onsetSens, P.onsetRiseCap), 1.0);
    }
    plosiveLevel *= P.onsetDecay;
    cumulativePlosive += plosiveLevel * dt;
    prevRawVol = rawVol;

    // Shape the plosive curve
    const shapedPlosive = Math.pow(plosiveLevel, P.plosiveShape);

    // Inject click pulse as synthetic plosive
    plosiveLevel = Math.min(plosiveLevel + clickPulse * 0.08, 1.0);

    // audioTime: idle drift + onset-driven jumps + hover speeds flow
    audioTime += dt * (1.0 + shapedPlosive * P.onsetSpeed + hoverBlend * 0.8);

    // Warp: fast attack, slow decay + hover adds surface detail + click spikes it
    const targetWarp = 1.5 + shapedPlosive * P.onsetWarp + hoverBlend * 1.2 + clickPulse * 4;
    const warpRate = targetWarp > smoothWarp ? P.warpAttack : P.warpDecay;
    smoothWarp += (targetWarp - smoothWarp) * warpRate;
  }

  // Render loop
  let running = true;
  const startTime = performance.now();
  let lastTime = startTime;
  let rafId = 0;

  function frame() {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const time = (now - startTime) / 1000;

    updateAudio(dt);

    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY_PROFILES[qualityMode].dprCap);
    const w = canvas.clientWidth * dpr;
    const h = canvas.clientHeight * dpr;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const { prog, uniforms: U } = programs[qualityMode];
    gl.useProgram(prog);
    gl.bindVertexArray(vao);

    const vol = (audioLevels[0] + audioLevels[1] + audioLevels[2] + audioLevels[3]) * 0.25;

    gl.uniform1f(U.uTime, time);
    gl.uniform1f(U.uVolume, vol);
    gl.uniform1f(U.uPlosive, plosiveLevel);
    gl.uniform1f(U.uCumPlosive, cumulativePlosive);
    gl.uniform4fv(U.uAudio, audioLevels);
    gl.uniform4fv(U.uCumAudio, cumulativeAudio);
    gl.uniform1f(U.uAudioTime, audioTime);
    gl.uniform1f(U.uWarp, smoothWarp);
    gl.uniform1f(U.uCoeffFbm, P.fbm);
    gl.uniform1f(U.uCoeffNoise, P.noise);
    gl.uniform1f(U.uCoeffRing, P.ring);
    gl.uniform1f(U.uNoiseAmp, P.noiseAmp);
    gl.uniform1f(U.uFbmAmp, P.fbmAmp);
    gl.uniform1f(U.uExtraBlend, P.extraBlend);
    gl.uniform1f(U.uCumPlosFbm, P.cumPlosFbm);
    gl.uniform1f(U.uCumPlosNoise, P.cumPlosNoise);
    gl.uniform1f(U.uQWarp, P.qWarp);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  rafId = requestAnimationFrame(frame);

  return {
    setAnalyser(node) {
      analyser = node;
      freqData = node ? new Uint8Array(node.frequencyBinCount) : null;
    },
    setQualityMode(mode) {
      if (mode === "baseline" || mode === "optimized") {
        qualityMode = mode;
      }
    },
    getQualityMode() {
      return qualityMode;
    },
    setHover(value) {
      hovered = !!value;
    },
    pulse(intensity = 1) {
      clickPulse = Math.min(clickPulse + intensity, 1.0);
    },
    destroy() {
      running = false;
      cancelAnimationFrame(rafId);
      gl.deleteProgram(programs.baseline.prog);
      gl.deleteProgram(programs.optimized.prog);
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
    },
  };
}
