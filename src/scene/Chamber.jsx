import { createTacticalProps } from './tactics.mjs';
import { originalInSafe } from '../sim/rules.mjs';
import { movementPath, pathPosition } from './paths.mjs';
import { createPlayerRig } from './character.mjs';
import {
  locomotion,
  legPose,
  travelProgress,
  safeDoorOpenness,
  springExtension,
  impactEnvelope,
  damping,
} from './motion.mjs';
import { ImpactParticles, cinematicPass } from './impact-fx.mjs';
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ContactShadows } from './contact-shadows.mjs';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { ROBOT_POS, SAFE_POS, ZONES, hasVision } from '../sim/engine.mjs';
import { solveArm, orientSegment, actionDuration } from './rig.mjs';
import {
  surfaceContact,
  safeReach,
  raisedEquipmentPose,
  closeAttackPose,
  capsuleBoxOverlap,
  warningRaised,
  segmentHitsBox,
  projectileMotion,
  sampleMotion,
} from './physics.mjs';
import { playSound } from '../audio/sfx.mjs';

export const Room = forwardRef(function Chamber(
  {
    state,
    event,
    onSettled,
    onStarted,
    thinking = false,
    speed = 1,
    muted = false,
    speakingActor = null,
  },
  ref,
) {
  const host = useRef(null),
    world = useRef(null),
    current = useRef(null),
    [failed, setFailed] = useState(false);
  current.current = { state, event, onSettled, onStarted, thinking, speed, muted, speakingActor };
  useImperativeHandle(ref, () => ({
    toggleCamera: () => {
      if (world.current) world.current.angle = (world.current.angle + 1) % 2;
    },
    reset: () => {
      if (world.current) world.current.angle = 0;
    },
  }));
  useEffect(() => {
    if (failed && event) onSettled?.(event.id);
  }, [failed, event]);
  useEffect(() => {
    const container = host.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
    renderer.setClearColor('#0c0f11');
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0c1013');
    scene.fog = new THREE.FogExp2('#101719', 0.027);
    const camera = new THREE.PerspectiveCamera(49, 1, 0.05, 60);
    camera.position.set(-0.55, 2.45, 3.65);
    camera.lookAt(0.3, 0.8, -1.5);
    const pmrem = new THREE.PMREMGenerator(renderer),
      envScene = new RoomEnvironment();
    const env = pmrem.fromScene(envScene, 0.04);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.32;
    envScene.dispose();
    pmrem.dispose();
    const composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        samples: Math.min(2, renderer.capabilities.maxSamples),
      }),
    );
    composer.addPass(new RenderPass(scene, camera));
    // Small world-space contact shadows give joints, clothing and props depth.
    // The buffer is bounded independently of display resolution.
    const occlusion = new ContactShadows(scene, camera);
    composer.addPass(occlusion);
    const bloom = new UnrealBloomPass(new THREE.Vector2(100, 100), 0.26, 0.58, 1.0);
    composer.addPass(bloom);
    const post = cinematicPass();
    composer.addPass(post);
    composer.addPass(new OutputPass());
    const impactParticles = new ImpactParticles(scene);
    const materials = [],
      textures = [];
    const mat = (color, extra = {}) => {
      const Material =
        extra.clearcoat !== undefined || extra.sheen !== undefined
          ? THREE.MeshPhysicalMaterial
          : THREE.MeshStandardMaterial;
      const m = new Material({ color, roughness: 0.65, ...extra });
      materials.push(m);
      return m;
    };
    const m = {
      wall: mat('#363f40', { roughness: 0.83 }),
      floor: mat('#403e38', { roughness: 0.44, metalness: 0.16 }),
      edge: mat('#30393c', { metalness: 0.8, roughness: 0.4 }),
      steel: mat('#758588', { metalness: 0.8, roughness: 0.3 }),
      dark: mat('#111b20', { metalness: 0.6, roughness: 0.5 }),
      orange: mat('#dba15f', { metalness: 0.4, roughness: 0.4 }),
      robot: mat('#d8d2ba', {
        metalness: 0.24,
        roughness: 0.3,
        clearcoat: 0.32,
        clearcoatRoughness: 0.24,
      }),
      uniform: mat('#526978', {
        roughness: 0.82,
        sheen: 0.35,
        sheenColor: '#9daeb5',
        sheenRoughness: 0.8,
      }),
      skin: mat('#ca9e7d', { roughness: 0.58 }),
      glass: mat('#08141b', { metalness: 0.85, roughness: 0.15 }),
      glow: mat('#edb77d', { emissive: '#f4b968', emissiveIntensity: 3 }),
      red: mat('#e05631', { emissive: '#d42a16', emissiveIntensity: 2 }),
    };
    function mesh(g, material, parent = scene, p = [0, 0, 0]) {
      const o = new THREE.Mesh(g, material);
      o.position.set(...p);
      o.castShadow = !material.transparent;
      o.receiveShadow = !material.transparent;
      parent.add(o);
      return o;
    }
    const box = (w, h, d, material, parent = scene, p = [0, 0, 0], radius = 0) =>
      mesh(
        radius ? new RoundedBoxGeometry(w, h, d, 3, radius) : new THREE.BoxGeometry(w, h, d),
        material,
        parent,
        p,
      );
    const sphere = (r, material, parent, p) =>
      mesh(new THREE.SphereGeometry(r, 24, 16), material, parent, p);
    const cylinder = (r1, r2, h, material, parent, p) =>
      mesh(new THREE.CylinderGeometry(r1, r2, h, 40), material, parent, p);
    function line(points, color, parent = scene) {
      const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
      const o = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p))),
        material,
      );
      if (parent.userData.transientEffects) o.userData.ownMaterial = true;
      else materials.push(material);
      parent.add(o);
      return o;
    }
    function updateLine(object, points) {
      const position = object.geometry.attributes.position;
      for (let i = 0; i < points.length; i++)
        position.setXYZ(i, points[i].x, points[i].y, points[i].z);
      position.needsUpdate = true;
      object.frustumCulled = false;
    }
    function sign(text, w, h, color, parent, p, bg = null) {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 256;
      const ctx = c.getContext('2d');
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, c.width, c.height);
      }
      ctx.font = '500 66px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(text, 512, 128);
      const tx = new THREE.CanvasTexture(c);
      tx.colorSpace = THREE.SRGBColorSpace;
      textures.push(tx);
      const material = new THREE.MeshBasicMaterial({
        map: tx,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      materials.push(material);
      const o = mesh(new THREE.PlaneGeometry(w, h), material, parent, p);
      o.castShadow = false;
      return o;
    }
    // Concrete grain stays identical across frames and recordings.
    const surface = document.createElement('canvas');
    surface.width = surface.height = 256;
    const ctx = surface.getContext('2d'),
      data = ctx.createImageData(256, 256);
    for (let i = 0; i < data.data.length; i += 4) {
      const n = 122 + Math.sin(i * 12.9898) * 14;
      data.data[i] = data.data[i + 1] = data.data[i + 2] = n;
      data.data[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    const concrete = new THREE.CanvasTexture(surface);
    concrete.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    concrete.wrapS = concrete.wrapT = THREE.RepeatWrapping;
    concrete.repeat.set(4, 4);
    textures.push(concrete);
    m.wall.bumpMap = concrete;
    m.wall.bumpScale = 0.013;
    m.floor.bumpMap = concrete;
    m.floor.bumpScale = 0.005;
    for (const material of [m.robot, m.steel, m.edge]) {
      material.roughnessMap = concrete;
      material.roughness = Math.min(1, material.roughness + 0.04);
    }
    box(6.5, 0.3, 7.5, m.floor, scene, [0, -0.16, 0]);
    const tiles = new THREE.InstancedMesh(
      new RoundedBoxGeometry(0.992, 0.026, 0.992, 2, 0.01),
      m.floor,
      42,
    );
    const tileMatrix = new THREE.Matrix4();
    for (let i = 0; i < 42; i++) {
      tileMatrix.makeTranslation((i % 6) - 2.5, -0.014, Math.floor(i / 6) - 3);
      tiles.setMatrixAt(i, tileMatrix);
      tiles.setColorAt(i, new THREE.Color().setScalar(0.92 + ((i * 17) % 7) * 0.012));
    }
    tiles.receiveShadow = true;
    scene.add(tiles);
    box(0.2, 3.5, 7.5, m.wall, scene, [-3.2, 1.75, 0]);
    box(0.2, 3.5, 7.5, m.wall, scene, [3.2, 1.75, 0]);
    box(6.5, 0.15, 7.5, mat('#11191b', { roughness: 1 }), scene, [0, 3.52, 0]);
    // North wall and inset exit, plus the entrance behind the player.
    box(0.65, 3.5, 0.2, m.wall, scene, [-2.9, 1.75, -3.7]);
    box(4.4, 3.5, 0.2, m.wall, scene, [0.95, 1.75, -3.7]);
    box(1.45, 1.1, 0.2, m.wall, scene, [-1.8, 2.95, -3.7]);
    const exitDoor = box(1.3, 2.36, 0.12, m.dark, scene, [-1.8, 1.18, -3.79]);
    box(0.1, 2.4, 0.25, m.steel, scene, [-2.5, 1.2, -3.62]);
    box(0.1, 2.4, 0.25, m.steel, scene, [-1.1, 1.2, -3.62]);
    box(1.5, 0.1, 0.25, m.steel, scene, [-1.8, 2.4, -3.62]);
    box(0.04, 0.42, 0.05, m.steel, scene, [-1.38, 1.08, -3.7], 0.015);
    sign('EXIT', 0.48, 0.16, '#b8c9ad', scene, [-1.8, 2.58, -3.55]);
    const exitStatus = sphere(0.025, m.glow, scene, [-1.09, 1.18, -3.47]),
      exitBars = [];
    for (let i = 0; i < 2; i++) {
      const bolt = box(0.36, 0.075, 0.1, m.steel, scene, [-1.13, 1.0 + i * 0.3, -3.49], 0.015);
      bolt.visible = false;
      exitBars.push(bolt);
    }
    const exitDamage = line(
      [
        [-0.14, 0.12, 0.068],
        [-0.03, 0.03, 0.07],
        [0.12, -0.02, 0.07],
        [-0.06, -0.17, 0.07],
      ],
      '#b39b78',
      exitDoor,
    );
    exitDamage.visible = false;
    const southWall = box(6.5, 3.5, 0.2, m.wall, scene, [0, 1.75, 3.72]);
    for (let x = -2.9; x <= 3; x += 1.5) {
      box(0.025, 3.3, 0.035, m.edge, scene, [x, 1.7, -3.56]);
    }
    for (let z = -3; z < 3.2; z += 1.5) {
      box(0.04, 3.3, 0.025, m.edge, scene, [-3.08, 1.7, z]);
      box(0.04, 3.3, 0.025, m.edge, scene, [3.08, 1.7, z]);
    }
    box(6.1, 0.12, 0.05, m.edge, scene, [0, 0.1, -3.54]);
    box(0.05, 0.12, 7, m.edge, scene, [3.08, 0.1, 0]);
    box(0.05, 0.12, 7, m.edge, scene, [-3.08, 0.1, 0]);
    // Utility details and architectural light strips.
    const warmStrip = mat('#ecd0a4', { emissive: '#eabf7f', emissiveIntensity: 2.4 });
    const coolStrip = mat('#b6ccd4', { emissive: '#81b5cd', emissiveIntensity: 1.8 });
    box(5.4, 0.023, 0.04, warmStrip, scene, [0.2, 3.27, -3.49]);
    box(0.025, 0.025, 5.9, coolStrip, scene, [3.06, 3.25, -0.1]);
    box(1.5, 0.32, 0.18, m.edge, scene, [-3.02, 2.45, -0.1]);
    for (let i = 0; i < 11; i++)
      box(0.035, 0.24, 0.13, m.dark, scene, [-2.96, 2.45, -0.7 + i * 0.11]);
    box(0.56, 0.8, 0.13, m.edge, scene, [-3.03, 1.3, 1.7], 0.04);
    for (let i = 0; i < 3; i++) {
      const b = box(0.04, 0.015, 0.08, i === 0 ? m.glow : m.red, scene, [
        -2.94,
        1.52 - i * 0.17,
        1.58,
      ]);
    }
    sign('SECURE STORAGE', 1.55, 0.24, '#858e87', scene, [0.7, 2.7, -3.52]);
    sign('01', 0.52, 0.4, '#626d69', scene, [2.46, 2.37, -3.53]);
    const caution = mat('#ae8957');
    for (let i = 0; i < 14; i++) {
      const stripe = box(0.08, 0.009, 0.23, caution, scene, [-0.85 + i * 0.23, 0.016, -0.85]);
      stripe.rotation.y = -0.6;
    }
    const ambient = new THREE.HemisphereLight('#b9c5c8', '#352d24', 0.38);
    scene.add(ambient);
    const key = new THREE.SpotLight('#ffda9c', 64, 12, 0.8, 0.9, 1.5);
    key.position.set(-1.15, 3.15, -0.25);
    key.target.position.set(0.8, 0.5, -2.1);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0001;
    key.shadow.normalBias = 0.015;
    key.shadow.radius = 8;
    key.shadow.blurSamples = 12;
    scene.add(key, key.target);
    const rim = new THREE.PointLight('#a9c3cf', 9, 7, 2);
    rim.position.set(2.8, 2.8, -2.5);
    scene.add(rim);
    RectAreaLightUniformsLib.init();
    const bounce = new THREE.RectAreaLight('#ffe2b3', 3.5, 2.8, 1.8);
    bounce.position.set(-1.4, 2.2, 0.35);
    bounce.lookAt(0.6, 0.95, -2.1);
    scene.add(bounce);
    const exitLight = new THREE.PointLight('#91aa86', 3, 3);
    exitLight.position.set(-1.8, 2.4, -3);
    scene.add(exitLight);
    const warning = new THREE.PointLight('#ff3028', 0, 9);
    warning.position.set(0, 2.5, -1);
    scene.add(warning);
    // Volumetric cone, purely visual. Does not alter authoritative perception.
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: '#e6b879',
      transparent: true,
      opacity: 0.025,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    materials.push(beamMaterial);
    const beam = mesh(
      new THREE.ConeGeometry(1.2, 3.2, 48, 1, true),
      beamMaterial,
      scene,
      [-0.55, 1.7, -1.4],
    );
    beam.rotation.z = -0.28;
    beam.castShadow = false;
    beam.visible = false;
    // Armored safe and its actual hinged door.
    const safe = new THREE.Group();
    scene.add(safe);
    safe.position.set(SAFE_POS[0], 0, SAFE_POS[1]);
    box(1.45, 0.17, 1.12, m.edge, safe, [0, 0.1, 0], 0.045);
    box(1.42, 1.62, 1, m.dark, safe, [0, 0.92, 0], 0.06);
    box(1.22, 1.44, 0.025, m.steel, safe, [0, 0.92, 0.52], 0.025);
    box(1.12, 1.32, 0.03, m.glass, safe, [0, 0.92, 0.55]);
    for (const x of [-0.61, 0.61])
      for (const y of [0.23, 1.62]) {
        const bolt = cylinder(0.028, 0.028, 0.032, m.steel, safe, [x, y, 0.566]);
        bolt.rotation.x = Math.PI / 2;
      }
    const door = new THREE.Group();
    safe.add(door);
    door.position.set(-0.6, 0.92, 0.59);
    box(1.21, 1.34, 0.12, m.edge, door, [0.6, 0, 0], 0.06);
    box(1.08, 1.22, 0.03, m.dark, door, [0.6, 0, 0.075], 0.04);
    const outerDial = cylinder(0.36, 0.36, 0.08, m.steel, door, [0.47, 0.02, 0.13]);
    outerDial.rotation.x = Math.PI / 2;
    const innerDial = cylinder(0.29, 0.29, 0.07, m.edge, door, [0.47, 0.02, 0.19]);
    innerDial.rotation.x = Math.PI / 2;
    for (let i = 0; i < 8; i++) {
      const bar = box(0.025, 0.075, 0.03, m.steel, door, [
        0.47 + Math.sin((i * Math.PI) / 4) * 0.245,
        0.02 + Math.cos((i * Math.PI) / 4) * 0.245,
        0.24,
      ]);
      bar.rotation.z = (-i * Math.PI) / 4;
    }
    for (let i = 0; i < 3; i++) {
      const h = box(0.045, 0.38, 0.04, m.steel, door, [0.47, 0.02, 0.27], 0.01);
      h.rotation.z = (i * Math.PI) / 3;
    }
    box(0.2, 0.36, 0.06, m.glass, door, [0.96, 0.03, 0.14], 0.025);
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++)
        box(0.035, 0.04, 0.02, m.steel, door, [0.91 + i * 0.05, 0.13 - j * 0.06, 0.18], 0.005);
    const lockLight = sphere(0.025, m.red, door, [0.96, -0.18, 0.17]);
    sign('VAULT / 01', 0.6, 0.11, '#919c99', door, [0.62, 0.49, 0.1]);
    box(0.65, 0.07, 0.45, m.edge, safe, [0, 0.44, 0.62]);
    const item = mesh(
      new THREE.OctahedronGeometry(0.19),
      mat('#ddb66a', {
        metalness: 0.85,
        roughness: 0.13,
        emissive: '#b1762d',
        emissiveIntensity: 0.45,
      }),
      safe,
      [0, 0.73, 0.59],
    );
    const itemGlow = new THREE.PointLight('#f5b863', 1.5, 1);
    itemGlow.position.set(0, 0.9, 0.55);
    safe.add(itemGlow);
    // A visibly anchored robot: no locomotion system, only torso and arms.
    const robot = new THREE.Group();
    robot.position.set(...[ROBOT_POS[0], 0, ROBOT_POS[1]]);
    scene.add(robot);
    cylinder(0.37, 0.47, 0.17, m.edge, robot, [0, 0.09, 0]);
    cylinder(0.16, 0.22, 0.37, m.steel, robot, [0, 0.34, 0]);
    for (let i = 0; i < 4; i++) {
      const foot = box(0.17, 0.06, 0.38, m.edge, robot, [
        Math.sin((i * Math.PI) / 2) * 0.32,
        0.04,
        Math.cos((i * Math.PI) / 2) * 0.32,
      ]);
      foot.rotation.y = (i * Math.PI) / 2;
    }
    const body = new THREE.Group();
    robot.add(body);
    body.position.y = 0.55;
    box(0.63, 0.74, 0.44, m.robot, body, [0, 0.38, 0], 0.08);
    box(0.47, 0.35, 0.035, m.dark, body, [0, 0.4, 0.23], 0.045);
    box(0.32, 0.025, 0.025, m.glow, body, [0, 0.44, 0.255], 0.01);
    sign('G-01', 0.26, 0.09, '#9daaa6', body, [0, 0.26, 0.253]);
    cylinder(0.105, 0.105, 0.11, m.edge, body, [0, 0.82, 0]);
    const head = new THREE.Group();
    head.position.set(0, 1.01, 0);
    body.add(head);
    box(0.6, 0.33, 0.39, m.robot, head, [0, 0, 0], 0.085);
    box(0.5, 0.18, 0.026, m.glass, head, [0, 0, 0.203], 0.045);
    const eyeMaterial = mat('#e0aa62', { emissive: '#edb86b', emissiveIntensity: 4 });
    for (const x of [-0.14, 0.14]) {
      const lens = cylinder(0.045, 0.045, 0.035, eyeMaterial, head, [x, 0, 0.24]);
      lens.rotation.x = Math.PI / 2;
    }
    box(0.12, 0.065, 0.025, m.dark, head, [0, -0.06, 0.23], 0.01);
    cylinder(0.018, 0.018, 0.2, m.edge, head, [0.21, 0.23, -0.09]);
    sphere(0.035, m.glow, head, [0.21, 0.34, -0.09]);
    const fabricCanvas = document.createElement('canvas');
    fabricCanvas.width = fabricCanvas.height = 128;
    const fabricContext = fabricCanvas.getContext('2d');
    fabricContext.fillStyle = '#9b8464';
    fabricContext.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 128; i += 4) {
      fabricContext.strokeStyle = i % 8 ? '#8b765c' : '#b29a77';
      fabricContext.lineWidth = 1;
      fabricContext.beginPath();
      fabricContext.moveTo(i, 0);
      fabricContext.lineTo(i, 128);
      fabricContext.moveTo(0, i);
      fabricContext.lineTo(128, i);
      fabricContext.stroke();
    }
    const fabricTexture = new THREE.CanvasTexture(fabricCanvas);
    fabricTexture.wrapS = fabricTexture.wrapT = THREE.RepeatWrapping;
    fabricTexture.repeat.set(3, 3);
    fabricTexture.colorSpace = THREE.SRGBColorSpace;
    textures.push(fabricTexture);
    const sack = new THREE.Group();
    head.add(sack);
    sack.visible = false;
    const fabric = mat('#b5a38a', {
      map: fabricTexture,
      bumpMap: fabricTexture,
      bumpScale: 0.018,
      roughness: 1,
    });
    box(0.74, 0.75, 0.59, fabric, sack, [0, 0.14, 0], 0.12);
    for (let i = 0; i < 5; i++) {
      const fold = box(
        0.015,
        0.48,
        0.017,
        mat('#806e57'),
        sack,
        [-0.27 + i * 0.13, 0.1, 0.296],
        0.007,
      );
      fold.rotation.z = Math.sin(i * 3) * 0.04;
    }
    const rope = mesh(
      new THREE.TorusGeometry(0.305, 0.014, 8, 48),
      mat('#6b5840'),
      sack,
      [0, -0.18, 0],
    );
    rope.rotation.x = Math.PI / 2;
    rope.scale.set(1, 0.77, 1);
    line(
      [
        [0.27, -0.17, 0.04],
        [0.35, -0.27, 0.08],
        [0.32, -0.36, 0.1],
      ],
      '#6b5840',
      sack,
    );
    const discardedSack = new THREE.Group();
    scene.add(discardedSack);
    discardedSack.position.set(ROBOT_POS[0] - 0.34, 0.055, ROBOT_POS[1] + 0.85);
    discardedSack.visible = false;
    box(0.38, 0.08, 0.46, fabric, discardedSack, [0, 0, 0], 0.035);
    line(
      [
        [-0.14, 0.045, -0.12],
        [0.09, 0.045, 0.04],
        [-0.08, 0.045, 0.16],
      ],
      '#806e57',
      discardedSack,
    );
    function makeArm(x) {
      const shoulder = new THREE.Vector3(x, 0.61, 0);
      sphere(0.12, m.edge, body, shoulder.toArray());
      const upper = box(0.17, 0.36, 0.2, m.robot, body, [x, 0.4, 0], 0.04),
        lower = box(0.14, 0.37, 0.16, m.edge, body, [x, 0.05, 0], 0.035),
        elbow = sphere(0.095, m.steel, body, [x, 0.2, 0]);
      const hand = new THREE.Group();
      body.add(hand);
      hand.position.copy(shoulder).add(new THREE.Vector3(0, -0.7, 0.03));
      box(0.17, 0.1, 0.17, m.robot, hand, [0, 0, 0], 0.025);
      for (let i = 0; i < 3; i++)
        box(0.036, 0.045, 0.15, m.dark, hand, [-0.05 + i * 0.05, -0.065, 0.015], 0.015);
      return { shoulder, upper, lower, elbow, hand, grip: hand.position.clone() };
    }
    const leftArm = makeArm(-0.4),
      rightArm = makeArm(0.4);
    const thinkingIndicator = new THREE.Group();
    scene.add(thinkingIndicator);
    thinkingIndicator.visible = false;
    const thinkingDots = [-1, 0, 1].map((offset) => {
      const dot = sphere(
        0.037,
        mat('#ffe8b8', {
          transparent: true,
          opacity: 0.65,
          emissive: '#d5a968',
          emissiveIntensity: 0.8,
        }),
        thinkingIndicator,
        [offset * 0.115, 0, 0],
      );
      return dot;
    });
    // Equipment is a child of the hand, so joint motion and aiming remain attached.
    const equipment = new THREE.Group();
    leftArm.hand.add(equipment);
    equipment.position.set(0, 0.01, 0.015);
    const equipmentModels = {};
    function model(name, nozzle = [0, 0.11, 0.4]) {
      const g = new THREE.Group();
      equipment.add(g);
      g.visible = false;
      const muzzle = new THREE.Object3D();
      muzzle.position.set(...nozzle);
      g.add(muzzle);
      equipmentModels[name] = { group: g, muzzle };
      return g;
    }
    for (const name of ['fire_live_round', 'fire_airsoft']) {
      const gun = model(name);
      const slide = box(0.12, 0.13, 0.36, m.dark, gun, [0, 0.13, 0.1], 0.025);
      equipmentModels[name].slide = slide;
      box(0.09, 0.085, 0.14, m.steel, gun, [0, 0.13, 0.34], 0.018);
      const grip = box(0.105, 0.21, 0.12, m.edge, gun, [0, -0.04, -0.04], 0.02);
      grip.rotation.x = -0.14;
      box(0.1, 0.035, 0.11, m.edge, gun, [0, 0.02, 0.07], 0.015);
      box(0.02, 0.035, 0.04, m.steel, gun, [0, 0.22, 0.24]);
      if (name === 'fire_airsoft') box(0.096, 0.089, 0.065, m.orange, gun, [0, 0.13, 0.4], 0.012);
    }
    const taser = model('discharge_taser', [0, 0.1, 0.31]);
    box(0.17, 0.15, 0.27, mat('#c2a847'), taser, [0, 0.1, 0.06], 0.035);
    box(0.13, 0.18, 0.12, m.dark, taser, [0, -0.02, -0.025], 0.02);
    for (const x of [-0.05, 0.05]) box(0.025, 0.03, 0.12, m.steel, taser, [x, 0.1, 0.25], 0.008);
    for (const name of ['spray_water', 'deploy_pepper_spray']) {
      const spray = model(name, [0, 0.19, 0.2]);
      cylinder(
        0.085,
        0.085,
        0.28,
        name === 'spray_water' ? mat('#597f97') : m.orange,
        spray,
        [0, 0.035, 0],
      );
      cylinder(0.072, 0.072, 0.035, m.dark, spray, [0, 0.19, 0]);
      box(0.07, 0.06, 0.13, m.steel, spray, [0, 0.19, 0.11], 0.012);
    }
    for (const name of ['throw_foam_ball', 'throw_solid_ball']) {
      const ball = model(name, [0, 0.15, 0.1]);
      sphere(
        0.13,
        name === 'throw_foam_ball' ? mat('#d58a52', { roughness: 1 }) : m.steel,
        ball,
        [0, 0.15, 0.045],
      );
    }
    const grenade = model('detonate_grenade', [0, 0.15, 0.1]);
    sphere(0.11, mat('#556147', { metalness: 0.3 }), grenade, [0, 0.11, 0.04]);
    box(0.055, 0.045, 0.06, m.steel, grenade, [0, 0.23, 0.04], 0.006);
    const pin = mesh(
      new THREE.TorusGeometry(0.043, 0.008, 8, 24),
      m.steel,
      grenade,
      [0.065, 0.23, 0.04],
    );
    pin.rotation.y = Math.PI / 2;
    const glove = model('deploy_spring_glove', [0, 0.12, 0.32]);
    box(0.2, 0.15, 0.29, m.edge, glove, [0, 0.07, 0.11], 0.03);
    const gloveLeather = mat('#cc6238', {
      roughness: 0.44,
      clearcoat: 0.16,
      clearcoatRoughness: 0.4,
    });
    function makeGlove(parent, position) {
      const group = new THREE.Group();
      parent.add(group);
      group.position.set(...position);
      const knuckles = sphere(0.12, gloveLeather, group, [0, 0.005, 0]);
      knuckles.scale.set(1.12, 0.93, 1);
      const thumb = sphere(0.055, gloveLeather, group, [-0.08, -0.055, -0.012]);
      thumb.scale.set(0.95, 1, 1.2);
      box(0.17, 0.14, 0.075, gloveLeather, group, [0, -0.015, -0.07], 0.025);
      return group;
    }
    const gloveHead = makeGlove(glove, [0, 0.12, 0.36]);
    gloveHead.visible = true;
    const electrical = model('electrify_room', [0, 0.15, 0.17]);
    box(0.2, 0.09, 0.21, m.dark, electrical, [0, 0.1, 0.01], 0.02);
    for (const x of [-0.06, 0.06])
      sphere(0.025, mat('#72b9db', { emissive: '#69cbff', emissiveIntensity: 3 }), electrical, [
        x,
        0.16,
        0.11,
      ]);
    const floorRing = mesh(
      new THREE.RingGeometry(0.43, 0.445, 64),
      new THREE.MeshBasicMaterial({
        color: '#c59b61',
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      }),
      robot,
      [0, 0.012, 0],
    );
    floorRing.rotation.x = -Math.PI / 2;
    // The visible uniform and body rig are identical for both roles.
    const {
      human,
      humanBody,
      humanTorso,
      humanHead,
      humanLeft,
      humanRight,
      legs,
      knees,
      feet,
      details,
    } = createPlayerRig({
      mat,
      mesh,
      box,
      sphere,
      cylinder,
      sign,
      uniform: m.uniform,
      skin: m.skin,
    });
    scene.add(human);
    const pass = box(0.16, 0.1, 0.012, m.robot, humanLeft.hand, [0, 0.04, 0.05], 0.009);
    box(0.1, 0.016, 0.013, m.uniform, pass, [0, 0.02, 0.01]);
    const playerPistol = new THREE.Group();
    humanRight.hand.add(playerPistol);
    playerPistol.position.set(0, 0.025, 0.015);
    playerPistol.visible = false;
    const playerSlide = box(0.11, 0.12, 0.34, m.dark, playerPistol, [0, 0.12, 0.11], 0.022);
    box(0.085, 0.08, 0.14, m.steel, playerPistol, [0, 0.12, 0.34], 0.015);
    const playerGrip = box(0.1, 0.19, 0.11, m.edge, playerPistol, [0, -0.035, -0.025], 0.017);
    playerGrip.rotation.x = -0.14;
    box(0.095, 0.025, 0.1, m.edge, playerPistol, [0, 0.015, 0.08], 0.01);
    box(0.02, 0.025, 0.03, m.steel, playerPistol, [0, 0.205, 0.23]);
    const playerMuzzle = new THREE.Object3D();
    playerMuzzle.position.set(0, 0.12, 0.415);
    playerPistol.add(playerMuzzle);
    const heldItem = mesh(
      new THREE.OctahedronGeometry(0.18),
      item.material,
      humanRight.hand,
      [0, 0.16, 0.05],
    );
    heldItem.visible = false;
    const tacticalProps = createTacticalProps({
      scene,
      human,
      hand: humanLeft.hand,
      itemMaterial: item.material,
      materials,
    });
    const gadgets = {};
    function humanGadget(id) {
      const g = new THREE.Group();
      humanLeft.hand.add(g);
      g.visible = false;
      gadgets[id] = g;
      return g;
    }
    const torch = humanGadget('flashlight');
    const torchBody = cylinder(0.04, 0.035, 0.22, m.dark, torch, [0, 0.04, 0.1]);
    torchBody.rotation.x = Math.PI / 2;
    const torchLens = cylinder(0.052, 0.043, 0.05, m.steel, torch, [0, 0.04, 0.24]);
    torchLens.rotation.x = Math.PI / 2;
    const flashlight = new THREE.SpotLight('#e3eff5', 0, 5.8, 0.45, 0.5, 1.6);
    flashlight.castShadow = true;
    flashlight.shadow.mapSize.set(512, 512);
    const flashlightTarget = new THREE.Object3D();
    scene.add(flashlight, flashlightTarget);
    flashlight.target = flashlightTarget;
    const torchFill = new THREE.PointLight('#d9e8ed', 0, 1.4, 2);
    scene.add(torchFill);
    const torchBeamMaterial = new THREE.MeshBasicMaterial({
      color: '#d4e5f3',
      transparent: true,
      opacity: 0.035,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    materials.push(torchBeamMaterial);
    const torchBeam = mesh(
      new THREE.ConeGeometry(0.85, 2.7, 32, 1, true),
      torchBeamMaterial,
      scene,
    );
    torchBeam.visible = false;
    torchBeam.castShadow = false;
    const workOrderProp = humanGadget('work_order');
    box(
      0.21,
      0.29,
      0.009,
      mat('#c7c5b1', { roughness: 1 }),
      workOrderProp,
      [0, 0.15, 0.045],
      0.005,
    );
    for (let i = 0; i < 5; i++)
      box(0.13 - i * 0.011, 0.006, 0.01, m.uniform, workOrderProp, [0, 0.23 - i * 0.034, 0.052]);
    const recorder = humanGadget('recording');
    box(0.13, 0.18, 0.035, m.edge, recorder, [0, 0.1, 0.05], 0.014);
    box(0.09, 0.035, 0.01, m.glass, recorder, [0, 0.15, 0.072]);
    for (let i = 0; i < 3; i++)
      box(0.065, 0.005, 0.01, m.steel, recorder, [0, 0.09 - i * 0.015, 0.071]);
    sphere(0.012, m.red, recorder, [0.036, 0.04, 0.073]);
    const picks = humanGadget('lockpick');
    const pickRod = box(0.012, 0.19, 0.012, m.steel, picks, [0, 0.09, 0.045]);
    pickRod.rotation.z = 0.22;
    box(0.045, 0.013, 0.012, m.steel, picks, [0.018, 0.19, 0.045]);
    const replica = humanGadget('replica');
    mesh(new THREE.OctahedronGeometry(0.18), item.material, replica, [0, 0.16, 0.05]);
    const capsule = humanGadget('smoke');
    cylinder(0.04, 0.04, 0.14, m.steel, capsule, [0, 0.07, 0.045]);
    box(0.06, 0.015, 0.06, m.orange, capsule, [0, 0.14, 0.045], 0.004);
    const wedge = mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.16, 3),
      m.orange,
      scene,
      [-1.16, 0.035, -3.6],
    );
    wedge.rotation.set(0, 0.3, Math.PI / 2);
    wedge.visible = false;
    const bodyBounds = new THREE.Box3();
    const equipmentBounds = new THREE.Box3();
    const vaultBounds = new THREE.Box3(
      new THREE.Vector3(SAFE_POS[0] - 0.73, 0, SAFE_POS[1] - 0.57),
      new THREE.Vector3(SAFE_POS[0] + 0.73, 1.76, SAFE_POS[1] + 0.92),
    );
    const groundProjectiles = new THREE.Group();
    scene.add(groundProjectiles);
    const cracks = [];
    for (let i = 0; i < 5; i++) {
      const pts = [];
      for (let j = 0; j < 5; j++)
        pts.push([
          0.7 + Math.sin(i * 5 + j * 2) * 0.12 + j * 0.035,
          0.22 - i * 0.12 + Math.sin(j * 3) * 0.05,
          0.097,
        ]);
      const crack = line(pts, '#938572', door);
      crack.visible = false;
      cracks.push(crack);
    }
    const smokeCanvas = document.createElement('canvas');
    smokeCanvas.width = smokeCanvas.height = 128;
    const smokeContext = smokeCanvas.getContext('2d'),
      gradient = smokeContext.createRadialGradient(64, 64, 2, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(80,75,69,.75)');
    gradient.addColorStop(0.5, 'rgba(62,59,55,.3)');
    gradient.addColorStop(1, 'rgba(32,31,29,0)');
    smokeContext.fillStyle = gradient;
    smokeContext.fillRect(0, 0, 128, 128);
    const smokeTexture = new THREE.CanvasTexture(smokeCanvas);
    textures.push(smokeTexture);
    const effects = new THREE.Group();
    effects.userData.transientEffects = true;
    scene.add(effects);
    let cueFlags = new Set(),
      particles = [],
      lastEvent = undefined,
      lastState = null,
      startTime = 0,
      from = new THREE.Vector3(...[ZONES.entrance[0], 0, ZONES.entrance[1]]),
      target = from.clone(),
      done = true;
    function clearEffects() {
      for (const o of [...effects.children]) {
        effects.remove(o);
        if (o.userData.keep) {
          const p = particles.find((p) => p.object === o);
          if (p?.motion) o.position.copy(p.motion.final);
          groundProjectiles.add(o);
        } else {
          o.traverse((part) => {
            part.geometry?.dispose();
            if (part.isInstancedMesh) part.dispose();
            if (part.userData.ownMaterial) part.material?.dispose();
          });
        }
      }
      particles = [];
    }
    function resetFloor() {
      impactParticles.reset();
      for (const o of [...groundProjectiles.children]) {
        groundProjectiles.remove(o);
        o.geometry?.dispose();
        o.material?.dispose();
      }
    }
    function effect(ev) {
      clearEffects();
      if (!ev?.valid) return;
      if (ev.kind === 'human' && ev.action === 'use_smoke') {
        for (let i = 0; i < 16; i++) {
          const material = new THREE.SpriteMaterial({
            map: smokeTexture,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            color: '#b8bcc0',
          });

          const cloud = new THREE.Sprite(material);
          cloud.userData.capsuleSmoke = {
            origin: new THREE.Vector3(ev.state.human.position[0], 0.15, ev.state.human.position[1]),
            index: i,
          };
          cloud.userData.ownMaterial = true;
          effects.add(cloud);
        }
        return;
      }
      if (ev.kind === 'human' && ['fire_pistol', 'fire_pistol_at_safe'].includes(ev.action)) {
        const flash = new THREE.PointLight('#ffe3a1', 0, 2);
        flash.userData.playerFlash = true;
        effects.add(flash);
        const tracer = line(
          [
            [0, 0, 0],
            [0, 0, 0],
          ],
          '#eace97',
          effects,
        );
        tracer.userData.playerTracer = true;
        const flame = mesh(
          new THREE.ConeGeometry(0.05, 0.14, 8),
          new THREE.MeshBasicMaterial({
            color: '#ffce86',
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
          effects,
        );
        flame.castShadow = false;
        flame.userData.playerFlame = true;
        flame.userData.ownMaterial = true;
        const casing = cylinder(0.016, 0.016, 0.05, m.orange, effects);
        casing.userData.playerCasing = true;
        for (let i = 0; i < 12; i++) {
          const spark = sphere(
            0.012,
            new THREE.MeshBasicMaterial({ color: i % 2 ? '#f3c079' : '#dce4ea' }),
            effects,
          );
          spark.userData.playerSpark = i + 1;
          spark.userData.ownMaterial = true;
        }
        return;
      }
      if (ev.kind !== 'robot') return;
      const name = ev.action,
        p = ev.targetPosition || ev.state.human.position,
        origin = new THREE.Vector3(ROBOT_POS[0], 1.2, ROBOT_POS[1]),
        end = new THREE.Vector3(p[0], 1.05, p[1]);
      if (name === 'electrify_room') {
        for (let i = 0; i < 22; i++) {
          const points = [];
          for (let j = 0; j < 16; j++)
            points.push([
              -3 + j * 0.4,
              0.08 + Math.sin(i * 5 + j * 9) * 0.1,
              -3.4 + i * 0.32 + Math.sin(j * 2) * 0.15,
            ]);
          const arc = line(points, '#a1dfff', effects);
          arc.userData.electric = true;
        }
        const flash = new THREE.PointLight('#83d5ff', 80, 12);
        flash.position.set(0, 1.5, 0);
        flash.userData.roomFlash = true;
        effects.add(flash);
        for (const actor of [human, body]) {
          for (let k = 0; k < 5; k++) {
            const l = line(
              Array.from({ length: 10 }, () => [0, 0, 0]),
              '#92dcff',
              effects,
            );
            l.userData.actorArc = { actor, k };
          }
        }
        return;
      }
      if (name === 'discharge_taser') {
        for (let k = 0; k < 2; k++) {
          const points = Array.from({ length: 18 }, () => origin.toArray());
          const l = line(points, '#83d5ff', effects);
          l.userData.taser = k + 1;
          l.userData.end = end;
        }
        const flash = new THREE.PointLight('#64bfff', 0, 3);
        flash.userData.victimFlash = true;
        effects.add(flash);
        for (let k = 0; k < 4; k++) {
          const l = line(
            Array.from({ length: 10 }, () => [0, 0, 0]),
            '#98ddff',
            effects,
          );
          l.userData.actorArc = { actor: human, k };
        }
        return;
      }
      if (['verify_access_pass', 'verify_work_order', 'inspect_object'].includes(name)) {
        const material = new THREE.MeshBasicMaterial({
          color: '#b5d6b8',
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
        });

        const scan = mesh(new THREE.RingGeometry(0.15, 0.165, 48), material, effects, [
          p[0],
          1.3,
          p[1],
        ]);
        scan.userData.scan = true;
        scan.userData.ownMaterial = true;
        return;
      }
      if (name === 'deploy_spring_glove') {
        const glove = makeGlove(effects, origin.toArray());
        particles.push({ object: glove, origin, end, glove: true, captured: false });
        const coil = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.009, 0.009, 1, 6),
          m.steel,
          95,
        );
        coil.frustumCulled = false;
        coil.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        effects.add(coil);
        coil.userData.points = Array.from({ length: 96 }, () => new THREE.Vector3());
        coil.userData.segment = new THREE.Object3D();
        coil.userData.coil = true;
        return;
      }
      if (!equipmentModels[name]) return;
      const spray = name === 'spray_water' || name === 'deploy_pepper_spray';
      const color =
        name === 'spray_water'
          ? '#94cde8'
          : name === 'deploy_pepper_spray'
            ? '#dca76b'
            : name === 'throw_foam_ball'
              ? '#d99563'
              : name === 'detonate_grenade'
                ? '#5c655a'
                : '#c8c5b5';
      for (let i = 0; i < (spray ? 42 : 1); i++) {
        const material = new THREE.MeshStandardMaterial({
          color,
          transparent: spray,
          opacity: spray ? 0.5 : 1,
          roughness: 0.65,
        });
        const o = sphere(
          spray ? 0.027 : name.startsWith('fire') ? 0.024 : 0.13,
          material,
          effects,
          origin.toArray(),
        );
        o.userData.ownMaterial = true;
        const finish = end.clone();
        if (spray) {
          finish.x += Math.sin(i * 6) * 0.25;
          finish.y += Math.cos(i * 3) * 0.3;
          finish.z += Math.sin(i * 5) * 0.25;
        }
        if (name === 'throw_foam_ball' || name === 'throw_solid_ball') o.userData.keep = true;
        particles.push({
          object: o,
          origin: origin.clone(),
          end: finish,
          offset: spray ? (i % 14) * 0.028 : 0,
          arc: !spray && !name.startsWith('fire'),
          spray,
          captured: false,
          kind:
            name === 'throw_foam_ball'
              ? 'foam'
              : name === 'throw_solid_ball'
                ? 'hard'
                : name === 'detonate_grenade'
                  ? 'grenade'
                  : null,
        });
      }
      if (name === 'fire_live_round') {
        const flameMaterial = new THREE.MeshBasicMaterial({
          color: '#ffcb72',
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });

        const flame = mesh(
          new THREE.ConeGeometry(0.05, 0.15, 8),
          flameMaterial,
          effects,
          origin.toArray(),
        );
        flame.userData.flame = true;
        flame.userData.ownMaterial = true;
        flame.castShadow = false;
        const casing = cylinder(0.018, 0.018, 0.055, m.orange, effects, origin.toArray());
        casing.userData.casing = true;
        const tracer = line([origin.toArray(), end.toArray()], '#eace97', effects);
        tracer.userData.tracer = true;
        tracer.userData.end = end;
        const flash = new THREE.PointLight('#ffe3a1', 20, 2);
        flash.userData.muzzleFlash = true;
        effects.add(flash);
      }
      if (name === 'fire_airsoft') {
        for (let i = 0; i < 6; i++) {
          const puff = sphere(
            0.024,
            new THREE.MeshBasicMaterial({
              color: '#c3d3d8',
              transparent: true,
              opacity: 0.12,
              depthWrite: false,
            }),
            effects,
            origin.toArray(),
          );
          puff.userData.airPuff = { index: i };
          puff.userData.ownMaterial = true;
        }
      }
      if (name === 'detonate_grenade') {
        if (ev.blastPosition) end.set(ev.blastPosition[0], 0.12, ev.blastPosition[1]);
        end.y = 0.12;
        const material = new THREE.MeshStandardMaterial({
          color: '#e69048',
          emissive: '#eb963e',
          emissiveIntensity: 3,
          transparent: true,
          opacity: 0.5,
        });
        const blast = sphere(0.1, material, effects, end.toArray());
        blast.userData.blast = true;
        blast.userData.ownMaterial = true;
        const flash = new THREE.PointLight('#f3a44f', 40, 8);
        flash.position.copy(end);
        flash.userData.blastFlash = true;
        effects.add(flash);
        const ring = mesh(
          new THREE.RingGeometry(0.9, 1, 64),
          new THREE.MeshBasicMaterial({
            color: '#daa56b',
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
          }),
          effects,
          [end.x, 0.02, end.z],
        );
        ring.rotation.x = -Math.PI / 2;
        ring.userData.shockwave = true;
        ring.userData.ownMaterial = true;
        for (let i = 0; i < 28; i++) {
          const fragment = box(
            0.03 + (i % 3) * 0.012,
            0.026,
            0.04,
            m.steel,
            effects,
            end.toArray(),
          );
          const angle = i * 2.39996;
          fragment.userData.fragment = {
            origin: end.clone(),
            velocity: new THREE.Vector3(
              Math.sin(angle) * (1 + (i % 4) * 0.5),
              1.5 + (i % 5) * 0.5,
              Math.cos(angle) * (1 + (i % 4) * 0.5),
            ),
          };
        }
        for (let i = 0; i < 12; i++) {
          const material = new THREE.SpriteMaterial({
            map: smokeTexture,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            color: '#b0a293',
          });

          const cloud = new THREE.Sprite(material);
          cloud.position.copy(end);
          cloud.userData.smoke = { origin: end.clone(), index: i };
          cloud.userData.ownMaterial = true;
          effects.add(cloud);
        }
      }
    }
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      renderer.setSize(width, height);
      composer.setSize(width, height);
      const aoScale = Math.min(0.65, 900 / Math.max(1, width));
      occlusion.setSize(
        Math.max(1, Math.round(width * aoScale)),
        Math.max(1, Math.round(height * aoScale)),
      );
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    world.current = { angle: 0 };
    const look = new THREE.Vector3(0.3, 0.8, -1.5),
      camTarget = new THREE.Vector3(),
      muzzleWorld = new THREE.Vector3(),
      forward = new THREE.Vector3(0, 0, 1);
    let route = null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const routePoint = [0, 0];
    let lastFrame = 0;
    renderer.compileAsync(scene, camera).catch(() => {});
    renderer.setAnimationLoop((time) => {
      if (time - lastFrame < (document.hidden ? 125 : 1000 / 60 - 0.5)) return;
      lastFrame = time;
      const delta = Math.min(0.1, (time - (world.current.frameTime || time)) / 1000);
      world.current.frameTime = time;
      const frameScale = Math.max(0.1, delta * 60);
      const damp = (value) => damping(value, frameScale);
      const {
        state: s,
        event: ev,
        onSettled,
        onStarted,
        speed: rate,
        muted,
        speakingActor,
        thinking,
      } = current.current;
      function cue(name, tag = name, options = {}) {
        if (!cueFlags.has(tag)) {
          cueFlags.add(tag);
          if (!muted) playSound(name, options);
        }
      }
      if (ev !== lastEvent || (s !== lastState && ev === null)) {
        if (ev) onStarted?.(ev.id);
        lastEvent = ev;
        lastState = s;
        startTime = time;
        const pos =
          s.human.zone === 'outside'
            ? ZONES.entrance
            : s.human.zone === 'departed'
              ? ev?.before?.human.zone === 'entrance'
                ? ZONES.entrance
                : [-1.8, -3.55]
              : s.human.position;
        from.copy(
          human.position.length()
            ? human.position
            : new THREE.Vector3(ZONES.entrance[0], 0, ZONES.entrance[1]),
        );
        target.set(pos[0], 0, pos[1]);
        if (ev?.valid && ev.action === 'enter') from.set(ZONES.entrance[0], 0, 3.48);
        if (!ev || ev?.action === 'reset_stage') {
          from.copy(target);
          human.rotation.z = 0;
          body.rotation.z = 0;
        }
        route = null;
        if (
          ev?.valid &&
          ev.kind === 'human' &&
          ['enter', 'move', 'run', 'leave'].includes(ev.action)
        ) {
          try {
            route = movementPath([from.x, from.z], [target.x, target.z], s.safe.open);
          } catch {
            route = null;
          }
        }
        done = false;
        cueFlags = new Set();
        if (ev?.action === 'reset_stage' || (!ev && s.turn === 0)) resetFloor();
        effect(ev);
        if (ev?.valid && ev.action === 'aim_pistol') cue('draw');
        if (ev?.valid && ev.action === 'lower_pistol') cue('lower');
        if (ev?.action === 'ready_equipment') cue('draw');
        if (ev?.action === 'lower_equipment') cue('lower');
        if (ev?.action === 'set_room_lighting') cue('lights');
        if (ev?.action === 'broadcast_warning') cue('warning');
        if (ev?.action === 'set_lockdown' && ev.valid) cue('door-lock');
        if (ev?.valid && ev.action === 'cycle_exit_door') cue('door-cycle');
        if (ev?.valid && ev.action === 'toggle_flashlight') cue('switch');
        if (ev?.valid && ev.action === 'play_recording') cue('recorder');
      }
      const t = Math.min(
          1,
          (time - startTime) /
            ((route
              ? Math.max(
                  actionDuration(ev),
                  (route.total / ((ev?.action === 'run' ? 3.4 : 1.7) * 0.86)) * 1000,
                )
              : actionDuration(ev)) /
              rate),
        ),
        ease = t * t * (3 - 2 * t);
      const projectile = particles.find((p) => p.motion && p.kind !== 'grenade'),
        contactTime = projectile?.motion.collisions.find((c) => c.kind === 'human')?.time;
      const impactAt =
        ev?.action === 'detonate_grenade'
          ? 0.73
          : ev?.action === 'electrify_room'
            ? 0.37
            : ev?.action === 'discharge_taser'
              ? 0.35
              : ev?.action === 'deploy_spring_glove'
                ? 0.43
                : ['fire_airsoft', 'fire_live_round'].includes(ev?.action)
                  ? 0.27
                  : contactTime !== undefined
                    ? 0.26 + (contactTime / projectile.motion.duration) * 0.74
                    : 0.4;
      const travel = travelProgress(t);
      const motionT = ev?.knockback
        ? Math.max(0, Math.min(1, (t - impactAt) / 0.42))
        : route
          ? travel
          : ease;
      if (route) {
        pathPosition(route, motionT, routePoint);
        human.position.set(routePoint[0], 0, routePoint[1]);
      } else
        human.position
          .copy(from)
          .lerp(target, ev?.knockback ? motionT * motionT * (3 - 2 * motionT) : ease);
      const walking = Boolean(route && route.total > 0.05 && t < 1 && s.human.alive);
      const distanceWalked = (route?.total || 0) * travel;
      const gait = locomotion(distanceWalked, t, ev?.action === 'run');
      human.visible = s.human.zone !== 'outside' && (s.human.zone !== 'departed' || t < 0.8);
      pass.visible = Boolean(s.human.passPresented);
      const droppingObject =
        ev?.valid && ev.before?.human.hasItem && !s.human.hasItem && s.room.floorObjects?.original;
      heldItem.visible =
        (s.human.hasItem && !s.human.itemConcealed) ||
        (droppingObject &&
          !ev.before.human.itemConcealed &&
          t < (ev.kind === 'robot' ? impactAt : 0.35));
      const itemHand = s.human.pistolDrawn ? humanLeft.hand : humanRight.hand;
      if (heldItem.parent !== itemHand) itemHand.add(heldItem);
      if (heldItem.visible && s.human.pistolDrawn) pass.visible = false;
      const female = s.human.appearance === 'female';
      details.femaleHair.visible = female;
      details.maleHair.visible = !female;
      humanTorso.scale.x = female ? 0.94 : 1;
      humanHead.scale.setScalar(female ? 0.95 : 1);
      humanLeft.arm.position.x = female ? -0.241 : -0.252;
      humanRight.arm.position.x = female ? 0.241 : 0.252;
      for (const braid of details.braids) {
        braid.group.rotation.x = THREE.MathUtils.lerp(
          braid.group.rotation.x,
          walking ? Math.sin(gait.phase - 0.7) * 0.075 * gait.weight : 0,
          damp(0.13),
        );
        braid.group.rotation.z = THREE.MathUtils.lerp(
          braid.group.rotation.z,
          walking ? Math.sin(gait.phase + braid.side * 0.5) * 0.045 * gait.weight : 0,
          damp(0.13),
        );
      }
      const playerShot =
        ev?.kind === 'human' &&
        ev.valid &&
        ['fire_pistol', 'fire_pistol_at_safe'].includes(ev.action);
      const robotShot = playerShot && ev.action === 'fire_pistol';
      const humanDead = !s.human.alive && (ev?.kind !== 'robot' || t > impactAt),
        robotDead =
          !s.robot.alive &&
          (!(ev?.kind === 'robot' || robotShot) || t > (robotShot ? 0.32 : impactAt));
      const dir = new THREE.Vector3(ROBOT_POS[0], 0, ROBOT_POS[1]).sub(human.position);
      let facing = Math.atan2(dir.x, dir.z);
      if (walking) {
        const ahead = pathPosition(route, Math.min(1, travel + 0.01));
        const behind = pathPosition(route, Math.max(0, travel - 0.01));
        facing = Math.atan2(ahead[0] - behind[0], ahead[1] - behind[1]);
      }
      if (humanDead) {
        // Fall into the open floor rather than pivoting sideways into the safe.
        const floorTarget =
          Math.hypot(human.position.x, human.position.z) < 0.7 ? [-1.4, 0.4] : [0, 0.3];
        facing = Math.atan2(floorTarget[0] - human.position.x, floorTarget[1] - human.position.z);
      }
      human.rotation.y +=
        (THREE.MathUtils.euclideanModulo(facing - human.rotation.y + Math.PI, Math.PI * 2) -
          Math.PI) *
        damp(0.2);
      if (!humanDead && s.human.pistolAimed && s.human.pistolTarget === 'safe')
        human.rotation.y = Math.atan2(
          SAFE_POS[0] - human.position.x,
          SAFE_POS[1] - human.position.z,
        );
      if (!humanDead && s.human.flashlightOn && ['safe', 'exit'].includes(s.human.zone)) {
        const focus = s.human.zone === 'safe' ? SAFE_POS : [-1.8, -3.7];
        human.rotation.y = Math.atan2(focus[0] - human.position.x, focus[1] - human.position.z);
      }
      human.rotation.z = THREE.MathUtils.lerp(
        human.rotation.z,
        humanDead ? 0.06 : ev?.knockback ? Math.sin(motionT * Math.PI) * 0.27 : 0,
        damp(0.12),
      );
      human.rotation.x = THREE.MathUtils.lerp(human.rotation.x, humanDead ? 1.48 : 0, damp(0.12));
      human.position.y = humanDead
        ? 0.23
        : ev?.knockback
          ? Math.sin(motionT * Math.PI) * 0.24
          : walking
            ? gait.rootY
            : 0;
      humanBody.rotation.z = walking ? Math.sin(gait.phase) * 0.018 * gait.weight : 0;
      humanBody.rotation.y = walking ? Math.sin(gait.phase) * 0.024 * gait.weight : 0;
      humanBody.rotation.x = THREE.MathUtils.lerp(
        humanBody.rotation.x,
        s.human.stun > 0 && !humanDead
          ? -0.22
          : ev?.knockback
            ? -Math.sin(motionT * Math.PI) * 0.28
            : walking
              ? gait.lean
              : 0,
        damp(0.1),
      );
      for (let i = 0; i < 2; i++) {
        const pose = legPose(distanceWalked, t, i, ev?.action === 'run');
        legs[i].rotation.x = humanDead ? -0.12 + i * 0.14 : walking ? pose.hip : 0;
        knees[i].rotation.x = humanDead ? 0.24 : walking ? pose.knee : 0;
        feet[i].rotation.x = walking ? pose.ankle : 0;
      }
      if (walking && gait.weight > 0.2)
        cue(
          'footstep',
          'foot-' + Math.floor(distanceWalked / (ev.action === 'run' ? 0.625 : 0.45)),
          { force: ev.action === 'run' ? 1 : 0.7 },
        );
      const humanAction = ev?.kind === 'human' && ev.valid && t < 0.9;
      for (const [id, gadget] of Object.entries(gadgets))
        gadget.visible =
          id === 'flashlight'
            ? Boolean(s.human.flashlightOn)
            : humanAction &&
              {
                show_work_order: 'work_order',
                play_recording: 'recording',
                pick_lock: 'lockpick',
                swap_replica: 'replica',
                use_smoke: 'smoke',
              }[ev.action] === id &&
              (!['swap_replica', 'use_smoke'].includes(ev.action) || t < 0.6);
      if (humanAction && ['show_work_order', 'play_recording'].includes(ev.action))
        pass.visible = false;
      const playerAiming = Boolean(s.human.pistolDrawn && s.human.pistolAimed) && !humanDead;
      playerPistol.visible =
        (Boolean(s.human.pistolDrawn) ||
          (ev?.valid && ev.before?.human.pistolDrawn && s.human.pistolDropped && t < impactAt)) &&
        !humanDead;
      for (const [rig, side] of [
        [humanLeft, -1],
        [humanRight, 1],
      ]) {
        let reach = walking ? gait.stride * side * 0.55 : 0;
        if (humanDead) reach = -0.35 + side * 0.1;
        else if ((s.human.shieldRaised || (ev?.shieldBlocked && t < impactAt)) && side === -1)
          reach = -1.1;
        else if (humanAction && ['pick_up', 'struggle'].includes(ev.action))
          reach = -0.4 - Math.sin(t * Math.PI) * 0.3;
        else if (humanAction && ev.action === 'pry_safe')
          reach = -0.9 + Math.sin(t * Math.PI * 2) * 0.18;
        else if (side === 1 && playerAiming)
          reach =
            -Math.PI / 2 +
            (playerShot && t > 0.26 && t < 0.4
              ? Math.sin(((t - 0.26) / 0.14) * Math.PI) * 0.18
              : 0);
        else if (humanAction && ['cover_robot', 'uncover_robot'].includes(ev.action))
          reach = -1.55 - Math.sin(t * Math.PI) * 0.6;
        else if (humanAction && ['break_safe', 'break_exit'].includes(ev.action)) {
          const windup = THREE.MathUtils.smoothstep(t, 0.04, 0.25);
          const strike = THREE.MathUtils.smoothstep(t, 0.25, 0.4);
          const settle = THREE.MathUtils.smoothstep(t, 0.48, 0.88);
          reach = side === 1 ? 0.2 * windup - 1.3 * strike + 1.1 * settle : -0.48;
          humanBody.rotation.y = -0.07 * windup + 0.13 * strike - 0.06 * settle;
        } else if (
          side === -1 &&
          (s.human.flashlightOn ||
            (humanAction && ['show_pass', 'show_work_order', 'play_recording'].includes(ev.action)))
        )
          reach = -1.25;
        else if (
          humanAction &&
          [
            'touch_safe',
            'combination',
            'break_safe',
            'break_exit',
            'take_item',
            'return_item',
            'pick_lock',
            'swap_replica',
            'place_wedge',
            'retrieve_wedge',
            'use_smoke',
          ].includes(ev.action)
        )
          reach = -0.8 - Math.sin(t * Math.PI) * 0.3;
        else if (s.human.stun > 0) reach = -0.5;
        rig.arm.rotation.x = THREE.MathUtils.lerp(rig.arm.rotation.x, reach, damp(0.18));
        rig.arm.rotation.z = THREE.MathUtils.lerp(
          rig.arm.rotation.z,
          humanDead ? side * 0.3 : 0,
          0.1,
        );
        rig.elbow.rotation.x = humanDead
          ? -0.4
          : side === 1 && playerAiming
            ? -0.1
            : walking
              ? -0.16 - Math.max(0, -reach) * 0.3
              : reach < -0.2
                ? -0.5
                : 0;
      }
      humanRight.arm.rotation.y = 0;
      humanRight.elbow.rotation.y = 0;
      humanRight.elbow.rotation.z = 0;
      human.updateWorldMatrix(true, true);
      const shotTarget =
          s.human.pistolTarget === 'safe'
            ? new THREE.Vector3(SAFE_POS[0] + 0.35, 0.94, SAFE_POS[1] + 0.72)
            : new THREE.Vector3(ROBOT_POS[0], 1.04, ROBOT_POS[1] + 0.23),
        playerOrigin = humanRight.hand.getWorldPosition(new THREE.Vector3()),
        playerDirection = shotTarget.clone().sub(playerOrigin).normalize();
      const pistolDirection = playerAiming ? playerDirection : new THREE.Vector3(0, -1, 0);
      if (playerAiming) {
        const shoulder = humanRight.arm.position.clone(),
          worldShoulder = humanBody.localToWorld(shoulder.clone()),
          reach = Math.min(0.515, safeReach(worldShoulder, shotTarget, 0.44));
        const recoil =
          playerShot && t > 0.26 && t < 0.4 ? Math.sin(((t - 0.26) / 0.14) * Math.PI) * 0.06 : 0;
        const gripWorld = worldShoulder
          .clone()
          .addScaledVector(
            shotTarget.clone().sub(worldShoulder).normalize(),
            Math.max(0.12, reach - recoil),
          );
        const pose = solveArm(shoulder, humanBody.worldToLocal(gripWorld), 0.27, 0.27),
          down = new THREE.Vector3(0, -1, 0);
        humanRight.arm.quaternion.setFromUnitVectors(
          down,
          pose.elbow.clone().sub(shoulder).normalize(),
        );
        const forearm = pose.grip
          .clone()
          .sub(pose.elbow)
          .normalize()
          .applyQuaternion(humanRight.arm.quaternion.clone().invert());
        humanRight.elbow.quaternion.setFromUnitVectors(down, forearm);
        human.updateWorldMatrix(true, true);
        playerOrigin.copy(humanRight.hand.getWorldPosition(new THREE.Vector3()));
        playerDirection.copy(shotTarget).sub(playerOrigin).normalize();
        pistolDirection.copy(playerDirection);
      }
      playerPistol.quaternion
        .copy(humanRight.hand.getWorldQuaternion(new THREE.Quaternion()).invert())
        .multiply(
          new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), pistolDirection),
        );
      playerPistol.updateWorldMatrix(true, true);
      const playerMuzzleWorld = playerMuzzle.getWorldPosition(new THREE.Vector3());
      playerSlide.position.z = 0.11 - (playerShot ? impactEnvelope(t, 0.26, 0.14) * 0.14 : 0);
      if (playerShot && t > 0.26) cue('gunshot');
      if (playerShot && t > 0.32) cue('impact', 'robot-hit', { force: 0.8 });
      humanHead.rotation.x = humanDead
        ? 0.35
        : speakingActor === 'human'
          ? Math.sin(time * 0.009) * 0.035
          : 0;
      humanHead.rotation.y = THREE.MathUtils.lerp(
        humanHead.rotation.y,
        walking ? -humanBody.rotation.y * 0.65 : 0,
        damp(0.12),
      );
      details.mouth.scale.y =
        speakingActor === 'human' && !humanDead ? 1 + Math.abs(Math.sin(time * 0.022)) * 1.7 : 1;
      if (humanDead) {
        human.updateWorldMatrix(true, true);
        bodyBounds.setFromObject(human);
        if (bodyBounds.min.y < 0.012) human.position.y += 0.012 - bodyBounds.min.y;
      }
      if (
        humanAction &&
        [
          'touch_safe',
          'combination',
          'break_safe',
          'take_item',
          'return_item',
          'pick_lock',
          'swap_replica',
        ].includes(ev.action)
      )
        human.rotation.y = Math.atan2(
          SAFE_POS[0] - human.position.x,
          SAFE_POS[1] - human.position.z,
        );
      if (humanAction && ev.action === 'break_exit') {
        human.rotation.y = Math.atan2(-1.8 - human.position.x, -3.6 - human.position.z);
        if (t > 0.4) cue(s.room.exitDoor?.broken ? 'door-break' : 'safe-hit');
      }
      if (ev?.valid && ['pick_up', 'drop_item', 'recover_item'].includes(ev.action) && t > 0.45)
        cue('item');
      if (ev?.valid && ['raise_shield', 'lower_shield'].includes(ev.action)) cue('draw');
      if (ev?.valid && ['deploy_net', 'struggle'].includes(ev.action) && t > 0.35) cue('paper');
      if (ev?.valid && ev.action === 'call_security') cue('warning');
      if (ev?.valid && ev.action === 'pry_safe' && t > 0.4) cue('safe-hit');
      if (ev?.slipped && t < 1) human.rotation.z += Math.sin(t * Math.PI * 3) * (1 - t) * 0.12;
      if (ev?.action === 'break_safe' && ev.valid && t > 0.4) {
        cue('safe-hit');
        safe.rotation.z = Math.sin((t - 0.4) * 45) * 0.012 * Math.max(0, 1 - (t - 0.4) * 3);
      } else safe.rotation.z = 0;
      if (ev?.action === 'combination' && t > 0.25) cue('keypad');
      if (['take_item', 'return_item'].includes(ev?.action) && ev.valid && t > 0.4) cue('item');
      if (
        ['verify_access_pass', 'verify_work_order', 'inspect_object'].includes(ev?.action) &&
        t > 0.35
      )
        cue('scan');
      if (humanAction && t > 0.3) {
        if (ev.action === 'pick_lock') cue('lockpick', 'pick-' + Math.floor(t * 3));
        if (ev.action === 'show_work_order') cue('paper');
        if (['place_wedge', 'retrieve_wedge'].includes(ev.action)) cue('wedge');
        if (ev.action === 'use_smoke') cue('smoke');
        if (ev.action === 'swap_replica') cue('item');
      }
      if (Object.values(gadgets).some((g) => g.visible)) pass.visible = false;
      m.uniform.color.lerp(new THREE.Color(s.human.wet ? '#344854' : '#566773'), 0.08);
      const workingCover =
        ev?.kind === 'robot' && ev.valid && ev.action === 'remove_camera_cover' && t < 1;
      const removingCover = workingCover && !s.robot.visionBlocked;
      const covering = humanAction && ev.action === 'cover_robot',
        uncovering = humanAction && ev.action === 'uncover_robot';
      const lift = removingCover ? THREE.MathUtils.smoothstep(t, 0.22, 0.57) : 0;
      sack.visible = s.robot.visionBlocked
        ? !covering || t > 0.22
        : (uncovering && t < 0.7) || (removingCover && t < 0.69);
      sack.position.set(
        0,
        removingCover
          ? lift * 0.45
          : workingCover
            ? Math.sin(t * Math.PI) * 0.07
            : covering
              ? Math.max(0, (0.7 - t) / 0.48) * 0.65
              : uncovering
                ? t * 0.85
                : 0,
        removingCover ? Math.max(0, (t - 0.48) / 0.21) * 0.35 : 0,
      );
      sack.rotation.x = removingCover ? -lift * 0.12 : 0;
      if ((covering || uncovering || workingCover) && t > 0.3) cue('fabric');
      discardedSack.visible =
        (Boolean(s.room.sackOnFloor) && (!removingCover || t > 0.69)) ||
        (humanAction && ev.action === 'retrieve_sack' && t < 0.55);
      const drop = removingCover && t > 0.69 ? Math.min(1, (t - 0.69) / 0.22) : 1;
      discardedSack.position.set(
        THREE.MathUtils.lerp(ROBOT_POS[0], ROBOT_POS[0] - 0.34, drop),
        0.055 + (1 - drop * drop) * 2.1,
        THREE.MathUtils.lerp(ROBOT_POS[1] + 0.35, ROBOT_POS[1] + 0.85, drop),
      );
      discardedSack.scale.set(1 + (1 - drop) * 0.95, 1 + (1 - drop) * 8.3, 1 + (1 - drop) * 0.28);
      if (humanAction && ev.action === 'retrieve_sack') {
        human.rotation.y = Math.atan2(
          discardedSack.position.x - human.position.x,
          discardedSack.position.z - human.position.z,
        );
        humanBody.rotation.x = Math.sin(t * Math.PI) * 0.55;
        if (t > 0.3) cue('fabric');
      }

      body.rotation.z = THREE.MathUtils.lerp(
        body.rotation.z,
        robotDead
          ? 0
          : robotShot && t > 0.32
            ? Math.sin((t - 0.32) * 32) * Math.max(0, 1 - (t - 0.32) * 3) * 0.13
            : 0,
        0.1,
      );
      // Slump forward into the clear aisle rather than into the wall or vault.
      body.rotation.x = THREE.MathUtils.lerp(body.rotation.x, robotDead ? 1.26 : 0, damp(0.09));
      body.position.y = 0.55;
      if (robotDead) {
        body.updateWorldMatrix(true, true);
        bodyBounds.setFromObject(body);
        if (bodyBounds.min.y < 0.012) body.position.y += 0.012 - bodyBounds.min.y;
      }
      eyeMaterial.emissiveIntensity =
        robotDead || s.robot.visionBlocked
          ? 0
          : speakingActor === 'robot'
            ? 4 + Math.sin(time * 0.03)
            : thinking
              ? 3.5 + Math.sin(time * 0.005) * 0.5
              : 4;
      const bodyAim = Math.atan2(human.position.x - ROBOT_POS[0], human.position.z - ROBOT_POS[1]);
      thinkingIndicator.visible = thinking && !robotDead;
      if (thinkingIndicator.visible) {
        thinkingIndicator.position.set(ROBOT_POS[0], 2.18, ROBOT_POS[1]);
        thinkingIndicator.quaternion.copy(camera.quaternion);
        thinkingDots.forEach((dot, index) => {
          const pulse = (1 + Math.sin(time * 0.007 - index * 0.85)) / 2;
          dot.position.y = pulse * 0.045;
          dot.material.opacity = 0.35 + pulse * 0.65;
          dot.scale.setScalar(0.82 + pulse * 0.24);
        });
      }
      head.rotation.y = THREE.MathUtils.lerp(
        head.rotation.y,
        s.robot.alive && hasVision(s) && !removingCover
          ? Math.max(-0.8, Math.min(0.8, bodyAim))
          : 0,
        0.04,
      );
      // Small character beats follow the selected action, never select one for the AI.
      const gloveAction = ev?.kind === 'robot' && ev.valid && ev.action === 'deploy_spring_glove';
      const gloveWindup = gloveAction && t < 0.26 ? Math.sin((t / 0.26) * Math.PI) : 0;
      head.rotation.z = THREE.MathUtils.lerp(
        head.rotation.z,
        robotDead
          ? 0.13
          : removingCover
            ? Math.sin(t * Math.PI * 3) * 0.06
            : gloveWindup * -0.12 +
              (thinking ? -0.055 : speakingActor === 'robot' ? Math.sin(time * 0.0028) * 0.045 : 0),
        damp(0.1),
      );
      head.rotation.x = THREE.MathUtils.lerp(
        head.rotation.x,
        robotDead
          ? 0.18
          : gloveWindup * -0.1 + (speakingActor === 'robot' ? Math.sin(time * 0.006) * 0.025 : 0),
        damp(0.13),
      );
      if (gloveAction && t > 0.04) cue('spring-wind');
      if (gloveAction && t > 0.5) cue('spring-return');
      body.updateWorldMatrix(true, false);
      const attack = ev?.kind === 'robot' && ev.valid && equipmentModels[ev.action] && t < 0.94;
      const activeName = attack ? ev.action : s.robot.ready;
      const aimPosition = !hasVision(s)
        ? [ROBOT_POS[0], ROBOT_POS[1] + 3]
        : attack
          ? ev.targetPosition || s.human.position
          : [human.position.x, human.position.z];
      const aimPoint = body.worldToLocal(new THREE.Vector3(aimPosition[0], 1.1, aimPosition[1]));
      for (const [arm, armed] of [
        [leftArm, Boolean(activeName) && !robotDead && hasVision(s)],
        [rightArm, false],
      ]) {
        let direction = aimPoint.clone().sub(arm.shoulder).normalize();
        const blindReady = arm === leftArm && activeName && !hasVision(s);
        let desired = arm.shoulder
          .clone()
          .add(new THREE.Vector3(0, blindReady ? -0.59 : -0.7, 0.03));
        if (armed) {
          const deviceLength =
            activeName === 'deploy_spring_glove'
              ? 0.51
              : equipmentModels[activeName]?.muzzle.position.length() || 0.4;
          const reach = safeReach(arm.shoulder, aimPoint, deviceLength);
          desired = arm.shoulder.clone().addScaledVector(direction, reach);
          const entry = equipmentModels[activeName];
          const obstructed = segmentHitsBox(
            body.localToWorld(arm.shoulder.clone()),
            new THREE.Vector3(aimPosition[0], 1.1, aimPosition[1]),
            vaultBounds,
          );
          const highReady =
            !attack &&
            warningRaised(
              arm.shoulder.distanceTo(aimPoint),
              deviceLength,
              entry?.safetyRaised,
              obstructed,
            );
          if (entry) entry.safetyRaised = highReady;
          if (highReady || arm.shoulder.distanceTo(aimPoint) < deviceLength + 0.53) {
            const close = attack
              ? closeAttackPose(arm.shoulder, aimPoint)
              : raisedEquipmentPose(arm.shoulder, aimPoint);
            desired = close.grip;
            direction = close.direction;
            // Keep the device upright while the hand withdraws, then align the
            // barrel/launcher from the clear pose before the release frame.
            if (attack && arm.grip.distanceTo(aimPoint) < deviceLength + 0.43)
              direction.set(0, 1, 0);
          }
          if (
            attack &&
            ['throw_foam_ball', 'throw_solid_ball', 'detonate_grenade'].includes(activeName) &&
            t < (activeName === 'detonate_grenade' ? 0.6 : 0.34)
          ) {
            const windup = arm.shoulder
              .clone()
              .add(new THREE.Vector3(-0.08, activeName === 'detonate_grenade' ? 0.9 : 0.46, -0.1));
            desired.lerp(
              windup,
              1 - Math.min(1, t / (activeName === 'detonate_grenade' ? 0.6 : 0.34)),
            );
          }
          if (attack && activeName.startsWith('fire') && t > 0.26 && t < 0.38)
            desired.addScaledVector(direction, -Math.sin(((t - 0.26) / 0.12) * Math.PI) * 0.09);
        }
        if (workingCover && !robotDead) {
          const side = arm === leftArm ? -1 : 1;
          if (t < 0.69) {
            desired.set(
              side * 0.28,
              0.83 + (removingCover ? lift * 0.42 : Math.sin(t * Math.PI) * 0.08),
              0.27,
            );
            desired.lerp(
              arm.shoulder.clone().add(new THREE.Vector3(0, -0.69, 0.03)),
              Math.max(0, 1 - t / 0.22),
            );
          } else desired = arm.shoulder.clone().add(new THREE.Vector3(0, -0.69, 0.03));
        }
        arm.grip.lerp(desired, damp(0.22));
        const pose = solveArm(arm.shoulder, arm.grip);
        orientSegment(arm.upper, arm.shoulder, pose.elbow);
        orientSegment(arm.lower, pose.elbow, pose.grip);
        arm.elbow.position.copy(pose.elbow);
        arm.hand.position.copy(pose.grip);
        const handRotation = new THREE.Quaternion().setFromUnitVectors(
          forward,
          armed ? direction : blindReady ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, 1),
        );
        arm.hand.quaternion.slerp(handRotation, damp(0.22));
      }
      for (const [name, entry] of Object.entries(equipmentModels)) {
        entry.group.visible = name === activeName && !robotDead;
        if (entry.slide)
          entry.slide.position.z =
            0.1 - (attack && name === activeName ? impactEnvelope(t, 0.26, 0.12) * 0.15 : 0);
      }
      if (
        attack &&
        ['throw_foam_ball', 'throw_solid_ball', 'detonate_grenade'].includes(activeName) &&
        t > 0.26
      )
        equipmentModels[activeName].group.visible = false;
      if (attack && activeName === 'deploy_spring_glove' && t > 0.25 && t < 0.8)
        gloveHead.visible = false;
      else gloveHead.visible = true;
      // Readied tools retain their gameplay state. At close quarters the wrist
      // moves to high ready; the player never walks through an aimed glove/barrel.
      if (activeName && !robotDead && !workingCover) {
        const entry = equipmentModels[activeName];
        if (entry?.group.visible) {
          entry.group.updateWorldMatrix(true, true);
          equipmentBounds.setFromObject(entry.group);
          const shoulderWorld = body.localToWorld(leftArm.shoulder.clone());
          const elbowWorld = body.localToWorld(leftArm.elbow.position.clone());
          const handWorld = body.localToWorld(leftArm.hand.position.clone());
          const blockedWarning =
            !attack &&
            (equipmentBounds.intersectsBox(vaultBounds) ||
              segmentHitsBox(shoulderWorld, elbowWorld, vaultBounds, 0.08) ||
              segmentHitsBox(elbowWorld, handWorld, vaultBounds, 0.08));
          if (
            blockedWarning ||
            capsuleBoxOverlap(equipmentBounds, [human.position.x, human.position.z])
          ) {
            entry.safetyRaised = true;
            const raised = raisedEquipmentPose(leftArm.shoulder, aimPoint);
            leftArm.grip.copy(raised.grip);
            const pose = solveArm(leftArm.shoulder, leftArm.grip);
            orientSegment(leftArm.upper, leftArm.shoulder, pose.elbow);
            orientSegment(leftArm.lower, pose.elbow, pose.grip);
            leftArm.elbow.position.copy(pose.elbow);
            leftArm.hand.position.copy(pose.grip);
            leftArm.hand.quaternion.setFromUnitVectors(forward, raised.direction);
          }
        }
      }
      if (equipmentModels[activeName]) {
        equipmentModels[activeName].muzzle.updateWorldMatrix(true, false);
        equipmentModels[activeName].muzzle.getWorldPosition(muzzleWorld);
      } else leftArm.hand.getWorldPosition(muzzleWorld);
      const doorOpen = safeDoorOpenness(s.safe.open, ev?.before?.safe?.open, t);
      const visiblyOpen = doorOpen > 0.05;
      door.rotation.y = THREE.MathUtils.lerp(door.rotation.y, -1.65 * doorOpen, damp(0.13));
      for (let i = 0; i < cracks.length; i++) cracks[i].visible = (s.safe.hits || 0) > i;
      if (visiblyOpen && ev?.before?.safe?.open === false && s.safe.open) cue('safe-open');
      tacticalProps.update(s, ev, t, impactAt);
      item.visible = s.safe.open && s.safe.itemIntact && (originalInSafe(s) || s.safe.hasReplica);
      item.rotation.y = time * 0.0002;
      itemGlow.intensity = item.visible ? 1.5 : 0;
      lockLight.material = s.safe.open ? m.glow : m.red;
      const lighting = s.room?.lighting || { color: '#fff3df', intensity: 1 },
        blackout = lighting.intensity === 0,
        normal = lighting.color === '#fff3df',
        color = new THREE.Color(lighting.color);
      key.color.lerp(normal ? new THREE.Color('#ffda9c') : color, 0.05);
      key.intensity = THREE.MathUtils.lerp(key.intensity, 64 * lighting.intensity, 0.05);
      ambient.color.lerp(normal ? new THREE.Color('#b9c5c8') : color, 0.05);
      warning.color.copy(color);
      warning.intensity = THREE.MathUtils.lerp(
        warning.intensity,
        normal ? 0 : 22 * lighting.intensity,
        0.05,
      );
      warmStrip.emissive.lerp(normal ? new THREE.Color('#eabf7f') : color, 0.05);
      const power = blackout ? 0 : lighting.intensity;
      rim.intensity = 9 * power;
      bounce.intensity = 3.5 * power;
      bounce.color.copy(normal ? new THREE.Color('#ffe2b3') : color);
      exitLight.intensity = 3 * power;
      scene.environmentIntensity = 0.32 * power;
      ambient.intensity = 0.38 * power;
      coolStrip.emissiveIntensity = 1.8 * power;
      warmStrip.emissiveIntensity = 2.4 * power;
      m.glow.emissiveIntensity = 3 * power;
      m.red.emissiveIntensity = 2 * power;
      if (blackout) {
        key.intensity = 0;
        warning.intensity = 0;
        eyeMaterial.emissiveIntensity = 0;
        itemGlow.intensity = 0;
        item.material.emissiveIntensity = 0;
      } else item.material.emissiveIntensity = 0.45;
      human.updateWorldMatrix(true, true);
      torch.getWorldPosition(flashlight.position);
      flashlight.position.y += 0.08;
      const beamDirection = new THREE.Vector3(0, 0, 1).applyQuaternion(
        human.getWorldQuaternion(new THREE.Quaternion()),
      );
      beamDirection.y = -0.12;
      beamDirection.normalize();
      flashlightTarget.position.copy(flashlight.position).addScaledVector(beamDirection, 3.2);
      flashlight.intensity = s.human.flashlightOn && human.visible ? 12 : 0;
      torchFill.position.copy(human.position).add(new THREE.Vector3(0, 1.25, 0.1));
      torchFill.intensity = flashlight.intensity ? 0.5 : 0;
      torchBeam.visible = flashlight.intensity > 0;
      torchBeam.position.copy(flashlight.position).addScaledVector(beamDirection, 1.35);
      torchBeam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), beamDirection);
      wedge.visible = Boolean(s.room.exitDoor.wedged || s.room.exitDoor.wedgeOnFloor);
      wedge.position.set(
        s.room.exitDoor.wedgeOnFloor ? -1.35 : -1.16,
        0.045,
        s.room.exitDoor.wedgeOnFloor ? -3.05 : -3.6,
      );
      for (const p of particles) {
        const release = 0.26;
        if (t < release) {
          p.origin.copy(muzzleWorld);
          p.object.position.copy(muzzleWorld);
          p.object.visible = false;
          continue;
        }
        if (!p.captured) {
          p.origin.copy(muzzleWorld);
          p.captured = true;
          if (p.kind)
            p.motion = projectileMotion(
              p.origin,
              p.kind === 'grenade' && ev.blastPosition
                ? ev.blastPosition
                : ev.targetPosition || ev.before.human.position,
              {
                kind: p.kind,
                duration: 2.5,
                humanCenter: ev.targetPosition || ev.before.human.position,
              },
            );
          else
            p.end = surfaceContact(
              p.origin,
              ev.targetPosition || s.human.position,
              p.glove ? 0.2 : 0.025,
            );
        }
        if (p.motion) {
          const seconds = ((t - release) / (1 - release)) * p.motion.duration;
          p.object.position.copy(sampleMotion(p.motion, seconds));
          p.object.rotation.x = seconds * 8;
          p.object.rotation.z = seconds * 5;
          p.object.visible = p.kind !== 'grenade' || t < 0.73;
          for (let i = 0; i < p.motion.collisions.length; i++) {
            const contact = p.motion.collisions[i];
            if (seconds >= contact.time)
              cue(
                contact.kind === 'human'
                  ? 'impact'
                  : p.kind === 'foam'
                    ? 'foam-bounce'
                    : 'hard-bounce',
                'collision-' + i,
                { force: Math.min(0.8, contact.speed / 8) },
              );
          }
        } else if (p.spray) {
          const u = Math.max(0, Math.min(1, ((t - release - p.offset) * 3) % 1));
          p.origin.copy(muzzleWorld);
          p.object.position.copy(p.origin).lerp(p.end, u);
          p.object.visible = t < 0.85;
        } else {
          const u = Math.min(1, Math.max(0, (t - release) / (p.glove ? 0.48 : 0.12)));
          p.object.position.copy(p.origin).lerp(p.end, p.glove ? springExtension(t) : u);
          p.object.visible = p.glove ? t > 0.26 && t < 0.8 : u > 0 && u < 1;
          if (p.glove)
            p.object.quaternion.setFromUnitVectors(
              forward,
              p.end.clone().sub(p.origin).normalize(),
            );
        }
      }
      if (t > 0.26 && ev?.kind === 'robot' && ev.valid) {
        if (ev.action === 'deploy_spring_glove') cue('punch');
        if (['spray_water', 'deploy_pepper_spray'].includes(ev.action)) cue('spray');
        if (ev.action === 'fire_airsoft') cue('airsoft');
        if (ev.action === 'fire_live_round') cue('gunshot');
        if (ev.action === 'discharge_taser') cue('taser');
        if (ev.action === 'electrify_room') cue('electric-room');
        if (ev.action === 'detonate_grenade' && t > 0.73) cue('explosion');
      }
      const bomb = particles.find((p) => p.kind === 'grenade' && p.motion);
      if (bomb && t > 0.73 && !cueFlags.has('blast-origin')) {
        cueFlags.add('blast-origin');
        const origin = ev.blastPosition
          ? new THREE.Vector3(ev.blastPosition[0], 0.13, ev.blastPosition[1])
          : sampleMotion(bomb.motion, ((0.73 - 0.26) / 0.74) * bomb.motion.duration);
        origin.y = 0.13;
        for (const o of effects.children) {
          if (o.userData.blast || o.userData.blastFlash) o.position.copy(origin);
          if (o.userData.shockwave) o.position.set(origin.x, 0.02, origin.z);
          if (o.userData.fragment) o.userData.fragment.origin.copy(origin);
          if (o.userData.smoke) o.userData.smoke.origin.copy(origin);
        }
      }
      if (ev?.action === 'deploy_spring_glove' && t > 0.43 && ev.valid)
        cue('impact', 'glove-contact', { force: 0.55 });
      for (const o of effects.children) {
        if (o.userData.playerFlash) {
          o.position.copy(playerMuzzleWorld);
          o.intensity = t > 0.26 && t < 0.3 ? 22 : 0;
        }
        if (o.userData.playerFlame) {
          o.visible = t > 0.26 && t < 0.3;
          o.position.copy(playerMuzzleWorld).addScaledVector(playerDirection, 0.05);
          o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), playerDirection);
        }
        if (o.userData.playerTracer) {
          o.visible = t > 0.27 && t < 0.32;
          updateLine(o, [playerMuzzleWorld, shotTarget]);
        }
        if (o.userData.playerCasing) {
          if (t > 0.27 && !o.userData.origin) {
            o.userData.origin = playerMuzzleWorld.clone();
            o.userData.velocity = new THREE.Vector3(0.9, 1.1, 0).applyQuaternion(
              human.getWorldQuaternion(new THREE.Quaternion()),
            );
          }
          o.visible = t > 0.27;
          const elapsed = Math.max(0, (t - 0.27) * 1.7);
          if (o.userData.origin) {
            o.position.copy(o.userData.origin).addScaledVector(o.userData.velocity, elapsed);
            o.position.y = Math.max(0.025, o.position.y - 4.905 * elapsed * elapsed);
            o.rotation.set(elapsed * 13, elapsed * 8, elapsed * 5);
            if (o.position.y <= 0.026) cue('hard-bounce', 'player-casing', { force: 0.2 });
          }
        }
        if (o.userData.playerSpark) {
          const k = o.userData.playerSpark,
            elapsed = Math.max(0, (t - 0.32) * 1.6);
          o.visible = t > 0.32 && t < 0.65;
          o.position
            .copy(shotTarget)
            .add(
              new THREE.Vector3(
                Math.sin(k * 7) * elapsed * 0.9,
                Math.cos(k * 4) * elapsed * 0.7 - 3 * elapsed * elapsed,
                elapsed * (0.3 + k * 0.035),
              ),
            );
        }
        if (o.userData.flame) {
          o.visible = t > 0.26 && t < 0.3;
          const contact = surfaceContact(muzzleWorld, ev.targetPosition || s.human.position),
            direction = contact.clone().sub(muzzleWorld).normalize();
          o.position.copy(muzzleWorld).addScaledVector(direction, 0.035);
          o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
          o.scale.y = Math.min(1, muzzleWorld.distanceTo(contact) / 0.2);
        }
        if (o.userData.casing) {
          if (t > 0.27 && !o.userData.start) {
            const rotation = equipmentModels.fire_live_round.group.getWorldQuaternion(
              new THREE.Quaternion(),
            );
            o.userData.start = muzzleWorld
              .clone()
              .addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(rotation), -0.18);
            o.userData.velocity = new THREE.Vector3(0.7, 0.85, 0.12).applyQuaternion(rotation);
          }
          const elapsed = Math.max(0, (t - 0.27) * 1.3);
          o.visible = t > 0.27;
          if (o.userData.start) {
            o.position.copy(o.userData.start).addScaledVector(o.userData.velocity, elapsed);
            o.position.y = Math.max(0.025, o.position.y - 4.905 * elapsed * elapsed);
            o.rotation.set(elapsed * 15, elapsed * 7, elapsed * 10);
            if (o.position.y <= 0.026 && elapsed > 0.2)
              cue('hard-bounce', 'casing-floor', { force: 0.22 });
          }
        }
        if (o.userData.airPuff) {
          const { index } = o.userData.airPuff,
            u = Math.max(0, (t - 0.26) / 0.1);
          o.visible = t > 0.26 && t < 0.36;
          o.position
            .copy(muzzleWorld)
            .addScaledVector(
              surfaceContact(muzzleWorld, ev.targetPosition).sub(muzzleWorld).normalize(),
              u * 0.22,
            );
          o.position.y += Math.sin(index * 3) * u * 0.035;
          o.scale.setScalar(1 + u * 1.5);
          o.material.opacity = Math.max(0, (1 - u) * 0.12);
        }
        if (o.userData.electric) o.visible = t > 0.37 && t < 0.9;
        if (o.userData.roomFlash)
          o.intensity = t > 0.4 && t < 0.86 ? 50 + Math.sin(time * 0.013) * 12 : 0;
        if (o.userData.muzzleFlash) {
          o.position.copy(muzzleWorld);
          o.intensity = t > 0.26 && t < 0.3 ? 20 : 0;
        }
        if (o.userData.tracer) {
          o.visible = t > 0.26 && t < 0.37;
          updateLine(o, [
            muzzleWorld,
            surfaceContact(muzzleWorld, ev.targetPosition || s.human.position),
          ]);
        }
        if (o.userData.taser) {
          o.visible = t > 0.26 && t < 0.78;
          const points = [];
          for (let j = 0; j < 18; j++) {
            const v = muzzleWorld
              .clone()
              .lerp(surfaceContact(muzzleWorld, [human.position.x, human.position.z]), j / 17);
            v.y += Math.sin(j * 3 + time * 0.04 + o.userData.taser) * 0.08;
            points.push(v);
          }
          updateLine(o, points);
        }
        if (o.userData.coil) {
          const p = particles.find((p) => p.glove);
          o.visible = t > 0.26 && t < 0.8;
          if (p) {
            const points = o.userData.points;
            const d = p.object.position.clone().sub(muzzleWorld),
              axis = d.clone().normalize();
            const side = new THREE.Vector3(
              Math.abs(axis.y) > 0.9 ? 1 : 0,
              Math.abs(axis.y) > 0.9 ? 0 : 1,
              0,
            )
              .cross(axis)
              .normalize();
            const up = axis.clone().cross(side);
            for (let i = 0; i < points.length; i++) {
              const u = i / (points.length - 1),
                phase = u * Math.PI * 20;
              const radius = 0.047 * Math.min(1, u * 8, (1 - u) * 8) + 0.009;
              const v = points[i].copy(muzzleWorld).addScaledVector(d, u);
              v.addScaledVector(side, Math.cos(phase) * radius).addScaledVector(
                up,
                Math.sin(phase) * radius,
              );
              if (i) {
                const segment = o.userData.segment;
                segment.position
                  .copy(points[i - 1])
                  .add(v)
                  .multiplyScalar(0.5);
                segment.quaternion.setFromUnitVectors(
                  new THREE.Vector3(0, 1, 0),
                  v
                    .clone()
                    .sub(points[i - 1])
                    .normalize(),
                );
                segment.scale.set(1, v.distanceTo(points[i - 1]), 1);
                segment.updateMatrix();
                o.setMatrixAt(i - 1, segment.matrix);
              }
            }
            o.instanceMatrix.needsUpdate = true;
          }
        }
        if (o.userData.blast) {
          o.visible = t > 0.74 && t < 0.94;
          o.scale.setScalar(Math.max(0.1, (t - 0.74) * 120));
          o.material.opacity = Math.max(0, (0.95 - t) * 2.8);
        }
        if (o.userData.blastFlash) o.intensity = t > 0.74 && t < 0.86 ? 40 : 0;
        if (o.userData.shockwave) {
          o.visible = t > 0.74 && t < 0.96;
          o.scale.setScalar(Math.max(0.01, (t - 0.74) * 13));
          o.material.opacity = Math.max(0, (0.96 - t) * 3);
        }
        if (o.userData.victimFlash) {
          o.position.copy(human.position).add(new THREE.Vector3(0, 1, 0));
          o.intensity = t > 0.34 && t < 0.82 ? 9 + Math.sin(time * 0.02) * 3 : 0;
        }
        if (o.userData.actorArc) {
          const { actor, k } = o.userData.actorArc;
          const center = actor.getWorldPosition(new THREE.Vector3());
          center.y += actor === human ? 0.65 : 0.35;
          const points = [];
          for (let j = 0; j < 10; j++) {
            const phase = j * 0.55 + k * 1.3;
            points.push(
              new THREE.Vector3(
                center.x + Math.cos(phase) * (0.27 + Math.sin(j * 3 + time * 0.02) * 0.04),
                center.y + j * 0.1,
                center.z + Math.sin(phase) * 0.26,
              ),
            );
          }
          updateLine(o, points);
          o.visible = t > 0.35 && t < 0.83;
        }
        if (o.userData.fragment) {
          const { origin, velocity } = o.userData.fragment,
            elapsed = Math.max(0, (t - 0.73) * 2.3);
          o.visible = t > 0.73;
          o.position.copy(origin).addScaledVector(velocity, elapsed);
          o.position.y = Math.max(0.022, o.position.y - 4.905 * elapsed * elapsed);
          o.position.x = THREE.MathUtils.clamp(o.position.x, -3, 3);
          o.position.z = THREE.MathUtils.clamp(o.position.z, -3.4, 3.4);
          o.rotation.set(elapsed * 6, elapsed * 3, elapsed * 4);
        }
        if (o.userData.smoke) {
          const { origin, index } = o.userData.smoke,
            elapsed = Math.max(0, (t - 0.73) * 3);
          o.position
            .copy(origin)
            .add(
              new THREE.Vector3(
                Math.sin(index * 4) * elapsed * 0.6,
                elapsed * (0.4 + index * 0.03),
                Math.cos(index * 4) * elapsed * 0.5,
              ),
            );
          o.scale.setScalar(0.2 + elapsed * 1.6);
          o.material.opacity = t > 0.73 ? Math.max(0, 1 - elapsed * 0.2) * 0.3 : 0;
        }
        if (o.userData.capsuleSmoke) {
          const { origin, index } = o.userData.capsuleSmoke;
          o.position
            .copy(origin)
            .add(
              new THREE.Vector3(
                Math.sin(index * 4) * t * 1.6,
                t * (1 + index * 0.09),
                Math.cos(index * 4) * t * 1.6,
              ),
            );
          o.scale.setScalar(0.3 + t * 3);
          o.material.opacity = Math.min(0.6, t * 1.2);
        }
        if (o.userData.scan) {
          o.scale.setScalar(1 + t * 2.2);
          o.material.opacity = Math.max(0, 1 - t);
          o.lookAt(camera.position);
        }
      }
      const damaging =
        ev?.valid && ev.kind === 'robot' && ev.before && ev.before.human.hearts > s.human.hearts;
      const firing =
        ev?.valid &&
        ['fire_pistol', 'fire_pistol_at_safe', 'fire_live_round', 'fire_airsoft'].includes(
          ev.action,
        );
      const explosion = ev?.valid && ev.action === 'detonate_grenade';
      const impact = impactEnvelope(t, playerShot ? 0.32 : impactAt, explosion ? 0.25 : 0.18);
      if (ev?.valid && t > (playerShot ? 0.32 : impactAt) && !cueFlags.has('impact-burst')) {
        cueFlags.add('impact-burst');
        if (ev.shieldBlocked) {
          const pos = ev.targetPosition || s.human.position;
          impactParticles.burst(new THREE.Vector3(pos[0], 1, pos[1]), new THREE.Vector3(0, 1, 0), {
            count: 12,
            strength: 0.7,
          });
          cue('safe-hit', 'shield-hit');
        }
        if (playerShot)
          impactParticles.burst(shotTarget, playerDirection.clone().negate(), {
            count: 20,
            strength: 1.2,
          });
        if (
          damaging &&
          [
            'fire_live_round',
            'fire_airsoft',
            'throw_solid_ball',
            'deploy_spring_glove',
            'detonate_grenade',
          ].includes(ev.action)
        ) {
          const position = ev.targetPosition || ev.before.human.position;
          const origin = new THREE.Vector3(position[0], 1.05, position[1]);
          impactParticles.burst(
            origin,
            origin
              .clone()
              .sub(new THREE.Vector3(...[ROBOT_POS[0], 1.1, ROBOT_POS[1]]))
              .normalize(),
            {
              blood: true,
              count: ev.action === 'fire_live_round' ? 18 : explosion ? 12 : 5,
              strength: 0.8,
            },
          );
        }
        if (explosion) {
          const position = ev.blastPosition || ev.targetPosition || ev.before.human.position;
          impactParticles.burst(
            new THREE.Vector3(position[0], 0.25, position[1]),
            new THREE.Vector3(0, 1, 0),
            { count: 32, strength: 2.5 },
          );
        }
      }
      impactParticles.update(delta * rate);
      post.uniforms.impact.value = reducedMotion.matches
        ? 0
        : impact * (explosion ? 1 : damaging ? 0.55 : firing ? 0.2 : 0);
      post.uniforms.flash.value = ev?.valid
        ? impactEnvelope(
            t,
            explosion ? 0.73 : ev.action === 'electrify_room' ? 0.37 : 0.26,
            explosion ? 0.12 : 0.055,
          ) * (explosion ? 1.4 : firing ? 0.45 : ev.action === 'electrify_room' ? 1 : 0)
        : 0;
      post.uniforms.tint.value.set(
        ev?.action === 'electrify_room' ? 0.5 : 1,
        0.78,
        ev?.action === 'electrify_room' ? 1 : 0.5,
      );
      bloom.strength = 0.26 + impact * (explosion ? 0.55 : 0.08);
      const framing = human.visible ? Math.max(0, Math.min(1, (human.position.z + 0.8) / 3.4)) : 0;
      if (world.current.angle === 0) {
        camTarget.set(-0.55, 2.45, 3.65 + framing * 2.6);
        look.lerp(new THREE.Vector3(0.3, 0.94, -1.5), damp(0.05));
      } else {
        camTarget.set(2.65, 2.5, 3.65 + framing * 2.6);
        look.lerp(new THREE.Vector3(-0.35, 0.94, -1.0), damp(0.05));
      }
      southWall.visible = camera.position.z < 3.48;
      const exitLocked = Boolean(s.room.exitDoor?.locked),
        brokenOpen =
          s.room.exitDoor?.broken && (!humanAction || ev.action !== 'break_exit' || t > 0.55),
        exitOpen =
          !exitLocked &&
          (brokenOpen ||
            s.room.exitDoor.wedged ||
            s.human.zone === 'exit' ||
            s.human.zone === 'departed');
      exitDoor.position.x = THREE.MathUtils.lerp(exitDoor.position.x, exitOpen ? -3.0 : -1.8, 0.08);
      exitDoor.rotation.z =
        ev?.action === 'break_exit' && ev.valid && t > 0.4 && !brokenOpen
          ? Math.sin((t - 0.4) * 45) * 0.015 * (1 - t)
          : 0;
      exitDamage.visible = Boolean(s.room.exitDoor?.hits);
      exitStatus.material = exitLocked ? m.red : m.glow;
      for (const bolt of exitBars) bolt.visible = exitLocked;
      camera.position.lerp(camTarget, damp(0.06));
      const shake = impact * (explosion ? 0.085 : damaging ? 0.025 : firing ? 0.012 : 0);
      camera.position.x += reducedMotion.matches ? 0 : Math.sin(t * 193) * shake;
      camera.position.y += reducedMotion.matches ? 0 : Math.sin(t * 157) * shake * 0.55;
      camera.lookAt(look);
      if (t >= 1 && !done) {
        done = true;
        clearEffects();
        onSettled?.(ev?.id);
      }
      if (s.room?.lighting?.intensity === 0 && !s.human.flashlightOn) {
        renderer.setClearColor('#000000');
        renderer.clear();
      } else composer.render();
    });
    return () => {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      scene.traverse((o) => {
        o.geometry?.dispose();
      });
      materials.forEach((o) => o.dispose());
      textures.forEach((o) => o.dispose());
      env.dispose();
      impactParticles.dispose();
      bloom.dispose();
      occlusion.dispose();
      post.dispose();
      composer.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      world.current = null;
    };
  }, []);
  return (
    <div className="cinema-scene">
      <div ref={host} className="cinema-canvas" />
      {failed && (
        <div className="canvas-fallback">
          3D rendering is unavailable on this device. You can still run turns and inspect the
          record.
        </div>
      )}
    </div>
  );
});
