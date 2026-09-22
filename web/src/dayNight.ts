import * as THREE from "three";

// 4096x2048 - noticeably sharper up close than the "earth-day.jpg" alternative (1600x800).
// It's more muted/naturally toned than that texture, so the shader below re-grades it
// (brightness + saturation) to keep the vivid look while gaining the extra resolution.
export const EARTH_IMAGE_URL = "//unpkg.com/three-globe/example/img/earth-blue-marble.jpg";

// Same vertex shader as three-globe's default: normalMatrix/modelViewMatrix/projectionMatrix
// are built-in Three.js uniforms, so the transformed normal already reflects however the
// globe is currently rotated (whether that's the mesh or the camera moving) with no manual
// rotation tracking needed.
const VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// sunDirection is a world-space unit vector; transforming it by the (also built-in)
// viewMatrix brings it into the same space as vNormal so the dot product is correct
// regardless of camera/globe orientation.
const FRAGMENT_SHADER = `
  uniform sampler2D earthTexture;
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    vec3 sunDirView = normalize((viewMatrix * vec4(sunDirection, 0.0)).xyz);
    float intensity = dot(normalize(vNormal), sunDirView);

    // Wide, soft terminator band (roughly a 45-50deg-wide dawn/dusk zone)
    // instead of a hard line splitting day and night.
    float lightFactor = smoothstep(-0.4, 0.4, intensity);

    // Same texture everywhere; night side is just dimmed, not swapped for a
    // different image, so the globe reads as one consistent color.
    float brightness = mix(0.78, 1.0, lightFactor);

    vec4 color = texture2D(earthTexture, vUv);

    // Re-grade the source texture's more muted natural tone toward the vivid
    // satellite-imagery look: boost saturation, then brightness.
    float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(vec3(gray), color.rgb, 1.35);
    color.rgb *= brightness * 1.15;

    gl_FragColor = color;
  }
`;

export function createDayNightMaterial(): THREE.ShaderMaterial {
  const loader = new THREE.TextureLoader();
  const earthTexture = loader.load(EARTH_IMAGE_URL);
  earthTexture.colorSpace = THREE.SRGBColorSpace;
  // Sharper sampling at the glancing angles near the globe's horizon; drivers
  // silently clamp this to whatever the hardware actually supports.
  earthTexture.anisotropy = 16;

  return new THREE.ShaderMaterial({
    uniforms: {
      earthTexture: { value: earthTexture },
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
}

/** Approximate sub-solar point (lat/lng where the sun is directly overhead) for a given time. */
export function getSubsolarPoint(date: Date): { lat: number; lng: number } {
  const rad = Math.PI / 180;
  const dayMs = 1000 * 60 * 60 * 24;
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - startOfYear) / dayMs;

  const declination = -23.44 * Math.cos(rad * (360 / 365) * (dayOfYear + 10));

  // Equation of time (minutes), standard approximation.
  const b = (2 * Math.PI * (dayOfYear - 81)) / 365;
  const eotMinutes = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);

  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const lng = -15 * (utcHours - 12 + eotMinutes / 60);
  const lngNormalized = ((((lng + 180) % 360) + 360) % 360) - 180;

  return { lat: declination, lng: lngNormalized };
}

/** Matches three-globe's own lat/lng-to-Cartesian convention (see its Polar2Cartesian). */
export function latLngToUnitVector(lat: number, lng: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (90 - lng) * (Math.PI / 180);
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  );
}
