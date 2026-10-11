import * as THREE from 'three';
import { ROOM_POINTS } from '../sim/tactics.mjs';

// Pooled props: no per-turn geometry allocation. The engine owns their positions.
export function createTacticalProps({ scene, human, hand, itemMaterial, materials }) {
  const steel = new THREE.MeshStandardMaterial({
    color: '#657c80',
    metalness: 0.7,
    roughness: 0.38,
  });
  const rubber = new THREE.MeshStandardMaterial({ color: '#253039', roughness: 0.8 });
  const orange = new THREE.MeshStandardMaterial({
    color: '#ce9c57',
    metalness: 0.3,
    roughness: 0.5,
  });
  const cord = new THREE.LineBasicMaterial({ color: '#d6c7a5', transparent: true, opacity: 0.9 });
  const water = new THREE.MeshStandardMaterial({
    color: '#568c99',
    transparent: true,
    opacity: 0.23,
    roughness: 0.06,
    metalness: 0.35,
    depthWrite: false,
  });
  materials.push(steel, rubber, orange, cord, water);
  function box(parent, size, pos, material) {
    const o = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    o.position.set(...pos);
    o.castShadow = true;
    parent.add(o);
    return o;
  }
  function shield() {
    const g = new THREE.Group();
    box(g, [0.48, 0.61, 0.06], [0, 0, 0], steel);
    box(g, [0.4, 0.045, 0.07], [0, 0.15, 0], orange);
    box(g, [0.09, 0.18, 0.08], [0, 0, -0.055], rubber);
    return g;
  }
  function grabber() {
    const g = new THREE.Group();
    box(g, [0.035, 0.48, 0.035], [0, 0, 0], steel);
    box(g, [0.08, 0.12, 0.06], [0, -0.2, 0], orange);
    for (const side of [-1, 1]) {
      const jaw = box(g, [0.025, 0.12, 0.04], [side * 0.04, 0.25, 0], rubber);
      jaw.rotation.z = side * 0.35;
    }
    return g;
  }
  const objects = {
    shield: shield(),
    grabber: grabber(),
    original: new THREE.Mesh(new THREE.OctahedronGeometry(0.18), itemMaterial),
    pistol: new THREE.Group(),
  };
  box(objects.pistol, [0.1, 0.12, 0.34], [0, 0.02, 0], rubber);
  box(objects.pistol, [0.085, 0.19, 0.09], [0, -0.07, -0.1], steel);
  Object.values(objects).forEach((o) => {
    o.visible = false;
    scene.add(o);
  });
  const heldShield = shield();
  scene.add(heldShield);
  const heldGrabber = grabber();
  hand.add(heldGrabber);
  heldGrabber.rotation.x = Math.PI / 2;
  const crowbar = new THREE.Group();
  hand.add(crowbar);
  box(crowbar, [0.04, 0.52, 0.04], [0, 0.2, 0.03], steel);
  const hook = box(crowbar, [0.13, 0.04, 0.04], [0.045, 0.46, 0.03], steel);
  hook.rotation.z = -0.25;
  box(crowbar, [0.048, 0.16, 0.048], [0, 0.08, 0.03], orange);
  const net = new THREE.Group();
  scene.add(net);
  for (let level = 0; level < 5; level++) {
    const points = Array.from({ length: 33 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * 0.36, 0.1 + level * 0.14, Math.sin(a) * 0.3);
    });
    net.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), cord));
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    net.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(Math.cos(a) * 0.36, 0.1, Math.sin(a) * 0.3),
          new THREE.Vector3(Math.cos(a + 0.2) * 0.36, 0.66, Math.sin(a + 0.2) * 0.3),
        ]),
        cord,
      ),
    );
  }
  const puddles = Object.fromEntries(
    Object.entries(ROOM_POINTS).map(([zone, p]) => {
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.65, 32), water);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(p[0], 0.014, p[1]);
      mesh.scale.y = 0.75;
      scene.add(mesh);
      return [zone, mesh];
    }),
  );
  const end = new THREE.Vector3(),
    start = new THREE.Vector3();
  return {
    update(s, ev, t, impactAt = 0.4) {
      const active = ev?.valid && t < 1;
      for (const [id, mesh] of Object.entries(objects)) {
        const current = s.room.floorObjects?.[id],
          before = ev?.before?.room.floorObjects?.[id];
        const taking =
          active &&
          before &&
          !current &&
          ((ev.action === 'pick_up' && ev.args.object === id) || ev.action === 'recover_item');
        mesh.visible = Boolean(current || (taking && t < 0.7));
        if (!mesh.visible) continue;
        const zone = (current || before).zone,
          p = ROOM_POINTS[zone];
        end.set(p[0] + 0.43, id === 'original' ? 0.19 : 0.07, p[1] + 0.1);
        mesh.position.copy(end);
        mesh.rotation.set(id === 'original' ? 0 : -Math.PI / 2, 0.3, 0.2);
        if (active && current && !before && ['original', 'pistol'].includes(id)) {
          const h = ev.before.human.position;
          start.set(h[0], 0.95, h[1]);
          const dropAt = ev.kind === 'robot' ? impactAt : 0.35;
          const u = THREE.MathUtils.clamp((t - dropAt) / Math.max(0.05, 1 - dropAt), 0, 1);
          mesh.visible = t >= dropAt;
          mesh.position.lerpVectors(start, end, u);
          mesh.position.y += Math.sin(u * Math.PI) * 0.23;
          mesh.rotation.z += u * Math.PI;
        }
        if (taking) {
          if (ev.action === 'recover_item') end.set(0.25, 1, -2.6);
          else hand.getWorldPosition(end);
          mesh.position.lerp(end, THREE.MathUtils.smoothstep(t, 0.2, 0.7));
        }
      }
      heldShield.visible = Boolean(s.human.shieldRaised || (ev?.shieldBlocked && t < impactAt));
      // Follow the grip, but keep the plate upright rather than inheriting the bent wrist.
      hand.getWorldPosition(heldShield.position);
      heldShield.position.y += 0.16;
      heldShield.position.x += Math.sin(human.rotation.y) * 0.1;
      heldShield.position.z += Math.cos(human.rotation.y) * 0.1;
      heldShield.rotation.set(0, human.rotation.y, 0);
      heldGrabber.visible = active && ev.action === 'pick_up' && s.human.grabber;
      crowbar.visible = active && ev.action === 'pry_safe';
      net.visible = Boolean(s.human.restrained || (active && ev.action === 'struggle'));
      net.position.copy(human.position);
      net.rotation.y = human.rotation.y;
      net.scale.setScalar(1);
      if (active && ev.action === 'deploy_net') {
        const u = THREE.MathUtils.smoothstep(t, 0.15, 0.6);
        net.position.lerpVectors(start.set(1.5, 0.85, -1.8), human.position, u);
        net.position.y += Math.sin(u * Math.PI) * 0.2;
        net.scale.setScalar(0.2 + 0.8 * u);
      }
      if (active && ev.action === 'struggle') {
        net.scale.setScalar(1 + t * 0.7);
        net.position.y -= t * 0.5;
        net.visible = t < 0.8;
      }
      for (const [zone, p] of Object.entries(puddles))
        p.visible = (s.room.wetZones?.[zone] ?? -1) > s.turn;
    },
  };
}
