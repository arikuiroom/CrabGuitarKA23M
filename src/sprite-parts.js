// KA23Sprite sheets are the supplied, unmodified 2048 × 1152 RGBA exports.
// Rectangles use source pixels; translations and pivots use assembled pixels.
// Keep each translation INSIDE its animated group: CSS rotation must not replace it.
export const SPRITE_SHEET = Object.freeze({ width: 2048, height: 1152 });
export const SPRITE_URLS = Object.freeze(Object.fromEntries(
  ['red', 'mint', 'black', 'darkbrown', 'redbrown'].map(id => [id, `sprites/${id}.png?v=19`]),
));

// Draw the five detached limbs behind the intact body, then the movable arm.
// The body is a union of rectangles, rather than its bounding box, so none of
// the nearby detached claw/leg pixels can be copied into the fixed layer.
export const SPRITE_PARTS = [
  { id: 'leg0Part', className: 'limb leg leg0', clipId: 'leg0Clip',
    rects: [[261, 611, 148, 97]], translate: [50, 0], pivot: [450, 657] },
  { id: 'leg1Part', className: 'limb leg leg1', clipId: 'leg1Clip',
    rects: [[321, 761, 145, 119]], translate: [50, 0], pivot: [498, 809] },
  { id: 'leg2Part', className: 'limb leg leg2', clipId: 'leg2Clip',
    rects: [[1207, 605, 137, 95]], translate: [-50, 0], pivot: [1167, 650] },
  { id: 'leg3Part', className: 'limb leg leg3', clipId: 'leg3Clip',
    rects: [[1160, 753, 134, 114]], translate: [-50, 0], pivot: [1125, 799] },
  { id: 'clawPart', className: 'limb claw', clipId: 'clawClip',
    rects: [[181, 263, 313, 270]], translate: [32, 32], pivot: [502, 522] },
  { id: 'bodyPart', className: 'body-part', clipId: 'bodyClip', imageId: 'paintedImage',
    rects: [[494, 87, 1369, 518], [464, 533, 691, 228], [466, 761, 689, 180]], translate: [0, 0], pivot: null },
  { id: 'tremoloArm', className: 'arm-part', clipId: 'armClip',
    rects: [[685, 990, 335, 51]], translate: [0, -187], pivot: [690, 808] },
];

// Measured centerlines of the supplied sprite strings, bridge to nut.
// Visual highlighting and touch coordinates share this one geometry.
export const STRING_SEGMENTS = Object.freeze([
  [642,682.89,1524.83,318.58],
  [653.4,702.94,1532.17,336.93],
  [664.8,723.14,1539.45,355.12],
  [676.2,742.57,1546.48,372.71],
  [687.6,762.31,1553.54,390.35],
  [699,781.17,1560.35,407.38],
].map(Object.freeze));
export function stringPosition(x,y) {
  const first=STRING_SEGMENTS[0],last=STRING_SEGMENTS[5];
  const cx=(first[0]+last[0])/2,cy=(first[1]+last[1])/2;
  const ux=(first[2]+last[2])/2-cx,uy=(first[3]+last[3])/2-cy;
  const t=((x-cx)*ux+(y-cy)*uy)/(ux*ux+uy*uy);
  const sides=STRING_SEGMENTS.map(([ax,ay,bx,by])=>(bx-ax)*(y-ay)-(by-ay)*(x-ax));
  // Cross products measure transverse distance without longitudinal leakage.
  const distances=sides.map((side,i)=>{const [ax,ay,bx,by]=STRING_SEGMENTS[i];return side/Math.hypot(bx-ax,by-ay);});
  let interval=distances[0]<0?0:4;
  for(let i=0;i<5;i++)if(distances[i]>=0&&distances[i+1]<=0){interval=i;break;}
  const value=interval+distances[interval]/(distances[interval]-distances[interval+1]);
  return {t,value,sides,ux,uy};
}
// Hit areas stay comfortably larger than the visible grip and claw center.
export const SPRITE_HIT_REGIONS = Object.freeze({
  palm: Object.freeze({ x: 422, y: 452, rx: 120, ry: 105 }),
  arm: Object.freeze({ x: 974, y: 845, rx: 90, ry: 50 }),
});

export function mountSpriteParts(svg) {
  const ns = 'http://www.w3.org/2000/svg';
  const document = svg.ownerDocument;
  const create = (tag, attributes = {}) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  };
  const clips = svg.querySelector('#spriteClips');
  const parts = svg.querySelector('#spriteParts');
  clips.replaceChildren();
  parts.replaceChildren();
  for (const part of SPRITE_PARTS) {
    const clip = create('clipPath', { id: part.clipId, clipPathUnits: 'userSpaceOnUse' });
    for (const [x, y, width, height] of part.rects) clip.append(create('rect', { x, y, width, height }));
    clips.append(clip);
    const group = create('g', { id: part.id, class: part.className, 'data-sprite-part': part.id });
    if (part.pivot) {
      group.style.transformBox = 'view-box';
      group.style.transformOrigin = `${part.pivot[0]}px ${part.pivot[1]}px`;
    }
    const placement = create('g', { class: 'sprite-placement', transform: `translate(${part.translate.join(' ')})` });
    const image = create('image', {
      class: 'painted-sprite',
      width: SPRITE_SHEET.width, height: SPRITE_SHEET.height, preserveAspectRatio: 'xMidYMid meet',
      'clip-path': `url(#${part.clipId})`,
    });
    if (part.imageId) image.id = part.imageId;
    placement.append(image);
    group.append(placement);
    parts.append(group);
  }
  const { palm } = SPRITE_HIT_REGIONS;
  const hint = svg.querySelector('#palmHint');
  for (const [name, value] of Object.entries({ cx: palm.x, cy: palm.y, rx: palm.rx, ry: palm.ry })) {
    hint.setAttribute(name, String(value));
  }
  svg.querySelector('#palmLabel').setAttribute('x', String(palm.x));
  svg.querySelector('#palmLabel').setAttribute('y', String(palm.y + 5));
}

// Only the requested sheet is decoded. In particular, first paint does not race
// five large PNG decodes on mobile. Keep old artwork until its replacement is ready.
export function createSpritePainter(svg, {
  createImage = () => new Image(), loadTimeout = 8000, decodeTimeout = 1200, onState = () => {},
} = {}) {
  let revision = 0, cancelPending = null, displayed = null;
  const xlink = 'http://www.w3.org/1999/xlink';
  function prepare(url) {
    let image = createImage(), timer, decodeTimer, settled = false, decoding = false;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      rejectPromise = reject;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(decodeTimer);
        image.onload = image.onerror = null;
        if (error) reject(error); else resolve(image);
      };
      const loaded = () => {
        if (settled || decoding) return;
        decoding = true;
        clearTimeout(timer);
        if (!image.naturalWidth) { finish(new Error('Empty sprite image')); return; }
        // Some engines reject decode() for an otherwise loaded PNG. A successful
        // load is a usable fallback; a hung decode must not keep artwork blank.
        if (typeof image.decode !== 'function') { finish(); return; }
        decodeTimer = setTimeout(() => finish(), decodeTimeout);
        Promise.resolve().then(() => image.decode()).then(() => finish(), () => finish());
      };
      image.onload = loaded;
      image.onerror = () => finish(new Error('Sprite image failed to load'));
      timer = setTimeout(() => finish(new Error('Sprite image load timed out')), loadTimeout);
      image.src = url;
      if (image.complete && image.naturalWidth) loaded();
    });
    cancelPending = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(decodeTimer);
      image.onload = image.onerror = null;
      image.src = '';
      rejectPromise(new Error('Superseded sprite'));
    };
    return promise;
  }
  function commit(url, id) {
    // Replacing just the seven image nodes gives WebKit a fresh paint resource
    // after decoding; all clipping, transforms and animated groups stay intact.
    for (const previous of svg.querySelectorAll('.painted-sprite')) {
      const image = previous.cloneNode(false);
      image.setAttribute('href', url);
      image.setAttributeNS(xlink, 'xlink:href', url);
      previous.replaceWith(image);
    }
    displayed = id;
    svg.dataset.spriteDisplayed = id;
  }
  function state(value) {
    svg.dataset.spriteState = value;
    svg.setAttribute('aria-busy', String(value === 'loading'));
    onState(value);
  }
  return {
    async select(id) {
      if (!SPRITE_URLS[id]) return false;
      const token = ++revision;
      cancelPending?.(); cancelPending = null;
      svg.dataset.spriteRequested = id;
      if (displayed === id && svg.dataset.spriteState !== 'error') { state('ready'); return true; }
      state('loading');
      for (let attempt = 0; attempt < 2; attempt++) {
        const url = SPRITE_URLS[id] + (attempt ? '&paintRetry=1' : '');
        try {
          await prepare(url);
          if (token !== revision) return false;
          commit(url, id);
          state('ready');
          cancelPending = null;
          return true;
        } catch {
          if (token !== revision) return false;
        }
      }
      // Bounded fallback: let SVG's own image loader try if HTML image loading
      // failed. Never erase a previously visible color on a network failure.
      if (!displayed) commit(SPRITE_URLS[id], id);
      state('error');
      cancelPending = null;
      return false;
    },
  };
}
