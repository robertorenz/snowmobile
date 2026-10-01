/**
 * Graphics quality. The track itself (its shape, surface, jumps, obstacles)
 * is identical at every level, so a race is the same race; only how much is
 * drawn around it changes.
 */
export type Quality = 'low' | 'medium' | 'high';

export interface QualityDef {
  label: string;
  note: string;
  /** Real-time shadows, and the size of the shadow map. */
  shadows: boolean;
  shadowSize: number;
  /** Smoothed edges. Can only be chosen when the renderer is created. */
  antialias: boolean;
  /** Most pixels drawn per screen pixel; the game drops below this by itself if frames get slow. */
  pixelRatio: number;
  /** Old-style trees: three stacked cones instead of the detailed species. */
  simpleTrees: boolean;
  /** Fractions of the full number of trees, undergrowth plants, rock outcrops and snowflakes. */
  trees: number;
  undergrowth: number;
  rocks: number;
  snow: number;
  /** Clouds, birds, balloons, airliner, ski lift, cabins. The train, deer and crowd are always there. */
  extras: boolean;
  /** The rear-view mirror costs a second pass over the scene. */
  mirror: boolean;
  /** Plain flat colours for the road's surface patches instead of textured ones. */
  plainGround: boolean;
}

export const QUALITY: Record<Quality, QualityDef> = {
  low: {
    label: 'Low',
    note: 'For computers without a graphics card',
    shadows: false,
    shadowSize: 512,
    antialias: false,
    pixelRatio: 0.75,
    simpleTrees: true,
    trees: 0.35,
    undergrowth: 0,
    rocks: 0.4,
    snow: 0.3,
    extras: false,
    mirror: false,
    plainGround: true,
  },
  medium: {
    label: 'Medium',
    note: 'For laptops and built-in graphics',
    shadows: true,
    shadowSize: 1024,
    antialias: true,
    pixelRatio: 1,
    simpleTrees: false,
    trees: 0.6,
    undergrowth: 0.4,
    rocks: 0.7,
    snow: 0.6,
    extras: true,
    mirror: true,
    plainGround: false,
  },
  high: {
    label: 'High',
    note: 'Everything on',
    shadows: true,
    shadowSize: 2048,
    antialias: true,
    pixelRatio: 2,
    simpleTrees: false,
    trees: 1,
    undergrowth: 1,
    rocks: 1,
    snow: 1,
    extras: true,
    mirror: true,
    plainGround: false,
  },
};

/**
 * A first guess at the right level for this computer, from the name of its
 * graphics hardware. Software rendering (no GPU at all) gets Low; built-in
 * and mobile graphics get Medium; anything else gets High. The player can
 * change it in Settings.
 */
export function detectQuality(): Quality {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'low';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (/swiftshader|llvmpipe|software|basic render|softpipe/i.test(name)) return 'low';
    if (/intel|uhd|iris|hd graphics|mali|adreno|powervr|apple gpu|radeon\(tm\) graphics|vega/i.test(name)) return 'medium';
    return 'high';
  } catch {
    return 'medium';
  }
}
