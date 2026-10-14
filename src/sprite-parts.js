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

// The six string paths remain in the unchanged body/neck coordinate system.
// Hit areas stay comfortably larger than the visible grip and claw center.
export const SPRITE_HIT_REGIONS = Object.freeze({
  palm: Object.freeze({ x: 422, y: 452, rx: 120, ry: 105 }),
  arm: Object.freeze({ x: 974, y: 845, rx: 90, ry: 50 }),
});

export function mountSpriteParts(svg) {
  const ns = 'http://www.w3.org/2000/svg';
  const xlink = 'http://www.w3.org/1999/xlink';
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
      class: 'painted-sprite', href: SPRITE_URLS.red,
      width: SPRITE_SHEET.width, height: SPRITE_SHEET.height,
      'clip-path': `url(#${part.clipId})`,
    });
    image.setAttributeNS(xlink, 'xlink:href', SPRITE_URLS.red);
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
