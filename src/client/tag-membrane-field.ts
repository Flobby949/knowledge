import * as THREE from "three";

export type TagMembraneDatum = {
  candidate: boolean;
  color: string;
  diameter: number;
  id: string;
  opacity: number;
  phase: number;
  position: THREE.Vector3;
};

export type TagMembraneField = {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  setFocusedTag: (id: string | null) => void;
  setViewport: (cameraDistance: number, pixelRatio: number) => void;
};

const vertexShader = `
  attribute float aCandidate;
  attribute float aPhase;
  attribute float aSelected;
  attribute float aSize;
  attribute float aVisibility;
  attribute vec3 color;
  uniform float uCameraDistance;
  uniform float uPixelRatio;
  varying float vCandidate;
  varying vec3 vColor;
  varying float vPhase;
  varying float vSelected;
  varying float vVisibility;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    float depth = -viewPosition.z;
    float perspective = clamp(uCameraDistance / depth, 0.52, 1.72);
    float fog = 1.0 - smoothstep(7.6, 13.4, depth);

    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(aSize * perspective * uPixelRatio, 2.0, 192.0 * uPixelRatio);
    vCandidate = aCandidate;
    vColor = color;
    vPhase = aPhase;
    vSelected = aSelected;
    vVisibility = aVisibility * mix(0.28, 1.0, fog);
  }
`;

const fragmentShader = `
  varying float vCandidate;
  varying vec3 vColor;
  varying float vPhase;
  varying float vSelected;
  varying float vVisibility;

  float membraneRadius(float angle) {
    return 1.0
      + sin(angle * 3.0 + vPhase) * 0.072
      + sin(angle * 5.0 - vPhase * 1.7) * 0.032
      + cos(angle * 2.0 + vPhase * 0.6) * 0.022;
  }

  float ring(float radius, float target, float width) {
    return 1.0 - smoothstep(width, width * 2.2, abs(radius - target));
  }

  float port(vec2 point, float angle) {
    float radius = 0.82 * membraneRadius(angle);
    vec2 center = vec2(cos(angle), sin(angle)) * radius;
    float dotShape = 1.0 - smoothstep(0.026, 0.052, length(point - center));
    float pointAngle = atan(point.y, point.x);
    float angular = abs(atan(sin(pointAngle - angle), cos(pointAngle - angle)));
    float stem = (1.0 - smoothstep(0.018, 0.035, angular))
      * smoothstep(0.63, 0.69, length(point))
      * (1.0 - smoothstep(radius, radius + 0.02, length(point)));

    return max(dotShape, stem * 0.55);
  }

  void main() {
    vec2 point = (gl_PointCoord - 0.5) * 2.0;
    float angle = atan(point.y, point.x);
    float radius = length(point) / membraneRadius(angle);

    if (radius > 0.94) {
      discard;
    }

    float antialias = max(fwidth(radius), 0.004);
    float outer = ring(radius, 0.82, antialias * 1.25);
    float middle = ring(radius, 0.63, antialias);
    float inner = ring(radius, 0.45, antialias);
    float nucleus = ring(radius, 0.30, antialias * 0.85);
    float dash = step(
      0.31,
      fract((angle + 3.14159265) / 6.2831853 * 18.0 + vPhase * 0.08)
    );

    outer *= mix(1.0, dash, vCandidate);

    float body = (1.0 - smoothstep(0.12, 0.84, radius)) * 0.12;
    float contours = outer * 0.96 + middle * 0.72 + inner * 0.5 + nucleus * 0.3;
    float coreGlow = exp(-radius * radius * 17.0) * 0.72;
    float core = 1.0 - smoothstep(0.105, 0.155, radius);
    float pin = 1.0 - smoothstep(0.022, 0.052, length(point - vec2(-0.018, 0.025)));
    float ports = max(
      max(port(point, -2.92), port(point, -0.58)),
      max(port(point, 0.48), port(point, 2.18))
    );
    float light = 0.82 + 0.18 * clamp(
      dot(normalize(vec3(point, 0.9)), normalize(vec3(-0.45, 0.62, 1.0))),
      0.0,
      1.0
    );
    float selection = 1.0 + vSelected * 0.42;
    vec3 coldWhite = vec3(0.88, 0.99, 1.0);
    vec3 color = vColor
      * (body + contours * selection + coreGlow * selection)
      * light
      * 1.15;

    color += mix(vColor, coldWhite, 0.72) * core * 0.82;
    color += coldWhite * (pin * 0.94 + ports * 0.82);

    float alpha = clamp(body + contours + coreGlow + core + ports, 0.0, 1.0)
      * vVisibility;

    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createTagMembraneField(
  tags: TagMembraneDatum[],
  cameraDistance: number,
  pixelRatio: number,
): TagMembraneField {
  const positions = new Float32Array(tags.length * 3);
  const colors = new Float32Array(tags.length * 3);
  const sizes = new Float32Array(tags.length);
  const phases = new Float32Array(tags.length);
  const candidates = new Float32Array(tags.length);
  const visibility = new Float32Array(tags.length);
  const selected = new Float32Array(tags.length);
  const color = new THREE.Color();

  tags.forEach((tag, index) => {
    positions[index * 3] = tag.position.x;
    positions[index * 3 + 1] = tag.position.y;
    positions[index * 3 + 2] = tag.position.z;
    color.set(tag.color);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
    sizes[index] = tag.diameter;
    phases[index] = tag.phase;
    candidates[index] = tag.candidate ? 1 : 0;
    visibility[index] = tag.opacity;
  });

  const selectedAttribute = new THREE.BufferAttribute(selected, 1);
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aCandidate", new THREE.BufferAttribute(candidates, 1));
  geometry.setAttribute("aVisibility", new THREE.BufferAttribute(visibility, 1));
  geometry.setAttribute("aSelected", selectedAttribute);
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: true,
    fragmentShader,
    toneMapped: true,
    transparent: true,
    uniforms: {
      uCameraDistance: { value: cameraDistance },
      uPixelRatio: { value: pixelRatio },
    },
    vertexShader,
  });
  const points = new THREE.Points(geometry, material);

  points.frustumCulled = false;
  points.renderOrder = 1;

  return {
    points,
    setFocusedTag(id) {
      tags.forEach((tag, index) => {
        selected[index] = tag.id === id ? 1 : 0;
      });
      selectedAttribute.needsUpdate = true;
    },
    setViewport(nextCameraDistance, nextPixelRatio) {
      material.uniforms.uCameraDistance!.value = nextCameraDistance;
      material.uniforms.uPixelRatio!.value = nextPixelRatio;
    },
  };
}
