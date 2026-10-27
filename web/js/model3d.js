// 3D models: rendered with three.js on a transparent background. While idle a model is shown as a
// thumbnail image (no WebGL, no GPU load); double-click turns on a live viewer that can be rotated.
// Supported: glTF/GLB, FBX, OBJ (+MTL and textures dropped together), STL, PLY, 3MF, Collada (DAE).
import { h, toast } from './ui.js';
import { t } from './i18n.js';
import { MEDIA_NAME_RE } from './ops.js';

export const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', '3mf', 'dae'];
// Files that belong to a model when dropped together with it (materials, buffers, textures).
export const MODEL_ASSET_EXT = ['mtl', 'bin', 'png', 'jpg', 'jpeg', 'tga', 'bmp', 'webp', 'ktx2', 'dds'];

export const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1]?.toLowerCase() || '';

let threeLib = null;
async function three() {
  if (!threeLib) {
    const [THREE, { OrbitControls }] = await Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
    ]);
    threeLib = { THREE, OrbitControls };
  }
  return threeLib;
}

// Loads the model object for an element. `urlOf(name)` turns a board media name into a URL.
async function loadModel(el, urlOf) {
  const { THREE } = await three();
  const manager = new THREE.LoadingManager();
  const assets = el.assets || {};
  // Companion files (textures, .bin, .mtl) are stored as separate board media: map file names to them.
  manager.setURLModifier((url) => {
    const base = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]);
    const hit = assets[base] || assets[base.toLowerCase()];
    return hit && MEDIA_NAME_RE.test(hit) ? urlOf(hit) : url;
  });
  const url = urlOf(el.src);
  const ext = el.ext || extOf(el.name);
  const material = () => new THREE.MeshStandardMaterial({ color: 0xd8d8e0, roughness: 0.55, metalness: 0.1 });
  switch (ext) {
    case 'glb': case 'gltf': {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      return (await new GLTFLoader(manager).loadAsync(url)).scene;
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      return new FBXLoader(manager).loadAsync(url);
    }
    case 'obj': {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      const loader = new OBJLoader(manager);
      const mtlName = Object.keys(assets).find((n) => n.toLowerCase().endsWith('.mtl'));
      if (mtlName) {
        const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
        const materials = await new MTLLoader(manager).loadAsync(urlOf(assets[mtlName]));
        materials.preload();
        loader.setMaterials(materials);
      }
      const obj = await loader.loadAsync(url);
      if (!mtlName) obj.traverse((o) => { if (o.isMesh) o.material = material(); });
      return obj;
    }
    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      const geo = await new STLLoader(manager).loadAsync(url);
      // Many STL files carry zero normals: recompute them so the model is lit.
      geo.computeVertexNormals();
      const mat = material();
      mat.flatShading = true;
      if (geo.hasColors) mat.vertexColors = true;
      return new THREE.Mesh(geo, mat);
    }
    case 'ply': {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const geo = await new PLYLoader(manager).loadAsync(url);
      geo.computeVertexNormals();
      const mat = material();
      if (geo.getAttribute('color')) mat.vertexColors = true;
      return new THREE.Mesh(geo, mat);
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
      const obj = await new ThreeMFLoader(manager).loadAsync(url);
      obj.rotation.x = -Math.PI / 2; // 3MF is Z-up
      return obj;
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      return (await new ColladaLoader(manager).loadAsync(url)).scene;
    }
    default:
      throw new Error(t('Формат не поддерживается'));
  }
}

// Scene with lights and a camera framing the object. `cam` is a saved view ({ p, t } in units of the
// model's radius), so the model opens exactly as it was left.
async function makeStage(object, width, height, canvas, cam) {
  const { THREE } = await three();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-4, 2, -3);
  scene.add(fill);
  scene.add(object);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, size.length() * 0.5, 1e-6);
  const camera = new THREE.PerspectiveCamera(35, width / height, radius / 100, radius * 100);
  const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05;
  const target = new THREE.Vector3();
  if (cam && Array.isArray(cam.p) && cam.p.length === 3) {
    camera.position.set(cam.p[0] * radius, cam.p[1] * radius, cam.p[2] * radius);
    if (Array.isArray(cam.t) && cam.t.length === 3) target.set(cam.t[0] * radius, cam.t[1] * radius, cam.t[2] * radius);
  } else {
    camera.position.set(dist * 0.6, dist * 0.45, dist * 0.75);
  }
  camera.lookAt(target);
  return { THREE, renderer, scene, camera, radius, target };
}

function disposeStage(stage) {
  stage.scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
  stage.renderer.dispose();
  stage.renderer.forceContextLoss?.();
}

export const modelMethods = {
  draw_model(el, node) {
    if (this.modelViewer && this.modelViewer.id === el.id) return; // live viewer owns the node
    // A just-taken local snapshot is shown until the uploaded preview replaces the element's thumbnail.
    const local = this.localThumbs?.get(el.id);
    const thumb = (local && local.base === el.thumb && local.url) || (el.thumb && MEDIA_NAME_RE.test(el.thumb) ? this.session.mediaUrl(el.thumb) : '');
    const key = JSON.stringify([thumb, el.name]);
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.replaceChildren(
      thumb ? h('img', { class: 'md-thumb', src: thumb, draggable: 'false', alt: el.name || '' })
        : h('div', { class: 'md-wait' }, h('span', { class: 'spin' }), h('small', {}, t('Готовим превью…'))),
      h('div', { class: 'md-badge', title: t('Двойной клик — вращать') }, '3D'),
    );
    if (!el.thumb) this.ensureModelThumb(el);
  },

  // Renders a thumbnail once and stores it on the board (one client does it; everyone reuses it).
  async ensureModelThumb(el) {
    this.thumbJobs = this.thumbJobs || new Set();
    if (this.thumbJobs.has(el.id) || !this.session.canEdit) return;
    this.thumbJobs.add(el.id);
    try {
      const object = await loadModel(el, (n) => this.session.mediaUrl(n));
      const canvas = document.createElement('canvas');
      const W = 512, H = Math.max(64, Math.round((512 * el.h) / el.w));
      const stage = await makeStage(object, W, H, canvas, el.cam);
      stage.renderer.render(stage.scene, stage.camera);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      disposeStage(stage);
      const info = await this.session.addMediaFile(new File([blob], `${el.name || 'model'}.png`, { type: 'image/png' }));
      if (this.elements.has(el.id)) this.session.apply([{ k: 'upd', id: el.id, set: { thumb: info.name } }]);
    } catch (err) {
      console.warn('[liro] model preview failed', err);
      const node = this.nodes.get(el.id);
      if (node) node.replaceChildren(h('div', { class: 'md-wait' }, h('small', {}, `${t('Не удалось открыть модель')}: ${err.message || err}`)));
    } finally {
      this.thumbJobs.delete(el.id);
    }
  },

  // Live, rotatable view of one model (only one at a time).
  async startModelViewer(el) {
    if (this.modelViewer) this.stopModelViewer();
    const node = this.nodes.get(el.id);
    if (!node) return;
    const viewer = { id: el.id };
    this.modelViewer = viewer;
    node.dataset.key = '';
    node.replaceChildren(h('div', { class: 'md-wait' }, h('span', { class: 'spin' })));
    try {
      const { OrbitControls } = await three();
      const object = await loadModel(el, (n) => this.session.mediaUrl(n));
      if (this.modelViewer !== viewer) return;
      const canvas = h('canvas', { class: 'md-canvas' });
      const z = this.view.z;
      const stage = await makeStage(object, Math.max(64, el.w * z), Math.max(64, el.h * z), canvas, el.cam);
      const controls = new OrbitControls(stage.camera, canvas);
      controls.target.copy(stage.target);
      controls.enableDamping = true;
      controls.enablePan = false;
      node.replaceChildren(canvas, h('button', { class: 'md-done', onclick: () => this.stopModelViewer() }, t('Готово')));
      // The board must not treat pointer events on the canvas as dragging the element.
      canvas.addEventListener('pointerdown', (e) => e.stopPropagation());
      canvas.addEventListener('wheel', (e) => e.stopPropagation());
      Object.assign(viewer, { stage, controls, canvas });
      const tick = () => {
        if (this.modelViewer !== viewer) return;
        controls.update();
        stage.renderer.render(stage.scene, stage.camera);
        viewer.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      this.modelViewer = null;
      toast(`${t('Не удалось открыть модель')}: ${err.message || err}`, { error: true });
      this.renderEl(el);
    }
  },

  // Freezes the current view: the camera is saved on the element and the preview is re-rendered from it,
  // so everyone sees the model the way it was left, and the next live view starts from there.
  stopModelViewer() {
    const v = this.modelViewer;
    if (!v) return;
    this.modelViewer = null;
    cancelAnimationFrame(v.raf);
    if (v.stage) {
      const { camera, radius, renderer, scene } = v.stage;
      const r = (n) => Math.round((n / radius) * 1e4) / 1e4;
      const cam = { p: camera.position.toArray().map(r), t: v.controls.target.toArray().map(r) };
      let blobPromise = null;
      try {
        renderer.render(scene, camera);
        this.localThumbs = this.localThumbs || new Map();
        this.localThumbs.set(v.id, { url: v.canvas.toDataURL('image/png'), base: this.elements.get(v.id)?.thumb });
        blobPromise = new Promise((res) => v.canvas.toBlob(res, 'image/png'));
      } catch {}
      v.controls.dispose();
      const el0 = this.elements.get(v.id);
      if (el0 && this.session.canEdit) {
        this.session.apply([{ k: 'upd', id: v.id, set: { cam } }]);
        if (blobPromise) {
          blobPromise.then(async (blob) => {
            disposeStage(v.stage);
            if (!blob || !this.session) return;
            const info = await this.session.addMediaFile(new File([blob], `${el0.name || 'model'}.png`, { type: 'image/png' }));
            if (this.elements.has(v.id)) this.session.apply([{ k: 'upd', id: v.id, set: { thumb: info.name } }]);
          }).catch(() => {});
        } else disposeStage(v.stage);
      } else {
        disposeStage(v.stage);
      }
    }
    const el = this.elements.get(v.id);
    if (el) this.renderEl(el);
  },

  modelProps(el, btn, parts) {
    const a = h('a', { href: this.session.mediaUrl(el.src), download: el.name || 'model', target: '_blank', style: { display: 'none' } });
    parts.push(
      btn('cube', t('Вращать (двойной клик)'), () => this.startModelViewer(el)),
      a, btn('download', t('Скачать модель'), () => a.click()),
    );
  },
};
