import * as THREE from "three";

export type TagBubbleDatum = {
  candidate: boolean;
  color: string;
  diameter: number;
  id: string;
  opacity: number;
  position: THREE.Vector3;
};

export type TagBubbleField = {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  setFocusedTag: (id: string | null) => void;
  setViewport: (cameraDistance: number, pixelRatio: number) => void;
};

const vertexShader = `
  attribute float aCandidate;
  attribute float aSelected;
  attribute float aSize;
  attribute float aVisibility;
  attribute vec3 color;
  uniform float uCameraDistance;
  uniform float uPixelRatio;
  varying float vCandidate;
  varying vec3 vColor;
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
    vSelected = aSelected;
    vVisibility = aVisibility * mix(0.34, 1.0, fog);
  }
`;

const fragmentShader = `
  varying float vCandidate;
  varying vec3 vColor;
  varying float vSelected;
  varying float vVisibility;

  float ring(float radius, float target, float width) {
    return 1.0 - smoothstep(width, width * 2.0, abs(radius - target));
  }

  void main() {
    vec2 point = (gl_PointCoord - 0.5) * 2.0;
    float radius = length(point);

    if (radius > 0.98) {
      discard;
    }

    float antialias = max(fwidth(radius), 0.004);
    float body = 1.0 - smoothstep(0.84, 0.84 + antialias * 2.0, radius);
    float inner = 1.0 - smoothstep(0.63, 0.63 + antialias * 2.0, radius);
    float outerRing = ring(radius, 0.86, antialias * 1.4);
    float innerRing = ring(radius, 0.65, antialias);
    float selectedRing = ring(radius, 0.94, antialias * 1.35) * vSelected;
    float angle = atan(point.y, point.x);
    float dash = step(0.42, fract((angle + 3.14159265) / 6.2831853 * 16.0));

    outerRing *= mix(1.0, dash, vCandidate);

    vec3 cream = vec3(1.0, 0.975, 0.985);
    vec3 berry = vec3(0.776, 0.239, 0.408);
    vec3 color = mix(vColor, cream, 0.18) * body;

    color = mix(color, cream, inner * 0.48);
    color += cream * (outerRing * 0.88 + innerRing * 0.7);
    color = mix(color, berry, selectedRing * 0.92);

    float edge = max(body, max(outerRing, max(innerRing, selectedRing)));
    float alpha = clamp(edge, 0.0, 1.0) * vVisibility;

    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

export function createTagBubbleField(
  tags: TagBubbleDatum[],
  cameraDistance: number,
  pixelRatio: number,
): TagBubbleField {
  const positions = new Float32Array(tags.length * 3);
  const colors = new Float32Array(tags.length * 3);
  const sizes = new Float32Array(tags.length);
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
    candidates[index] = tag.candidate ? 1 : 0;
    visibility[index] = tag.opacity;
  });

  const selectedAttribute = new THREE.BufferAttribute(selected, 1);
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aCandidate", new THREE.BufferAttribute(candidates, 1));
  geometry.setAttribute("aVisibility", new THREE.BufferAttribute(visibility, 1));
  geometry.setAttribute("aSelected", selectedAttribute);
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: false,
    fragmentShader,
    toneMapped: false,
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
