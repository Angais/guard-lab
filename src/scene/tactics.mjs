import * as THREE from 'three';
import { ROOM_POINTS } from '../sim/tactics.mjs';
import { SAFE_POS } from '../sim/spatial.mjs';

// Dropped objects rest beside the player's feet, in view of the camera and clear
// of the guard base, the vault, the walls and each other. Bearings are degrees
// on the floor (0: +x, 90: toward the camera); the original lies where G-01's
// arm can reach it without passing through the player.
export const FLOOR_SLOTS = {
  entrance: { original: 45, pistol: 90, grabber: -30, shield: 140 },
  center: { original: 180, pistol: 225, grabber: 135, shield: 75 },
  safe: { original: 20, pistol: -15, grabber: 75, shield: 110 },
  robot: { original: 150, pistol: 195, grabber: 100, shield: 45 },
  exit: { original: 90, pistol: 125, grabber: 45, shield: 160 },
};
const SLOT_RADIUS = { original: 0.46, pistol: 0.5, grabber: 0.62, shield: 0.8 };
export function floorRestPoint(id, zone) {
  const p = ROOM_POINTS[zone] || ROOM_POINTS.center,
    bearing = ((FLOOR_SLOTS[zone]?.[id] ?? 0) * Math.PI) / 180,
    radius = SLOT_RADIUS[id] ?? 0.45;
  return [p[0] + Math.cos(bearing) * radius, p[1] + Math.sin(bearing) * radius];
}
// The original's position on the vault shelf, in world space.
export const SHELF_POINT = [SAFE_POS[0], 0.73, SAFE_POS[1] + 0.59];

const X = new THREE.Vector3(1, 0, 0),
  Y = new THREE.Vector3(0, 1, 0);
// Lying orientation of each object; yaw varies by zone so drops look placed by hand.
function restQuaternion(id, yaw, target) {
  target.setFromAxisAngle(Y, yaw);
  const lie = new THREE.Quaternion();
  if (id === 'pistol') lie.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  else if (id === 'shield') lie.setFromAxisAngle(X, Math.PI / 2);
  else if (id === 'grabber') lie.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  else lie.setFromUnitVectors(new THREE.Vector3(1, 1, 1).normalize(), new THREE.Vector3(0, -1, 0));
  return target.multiply(lie);
}

// Pooled props: no per-turn geometry allocation. The engine owns their positions.
export function createTacticalProps({
  scene,
  human,
  hand,
  rightHand = hand,
  robotHand = null,
  itemMaterial,
  materials,
}) {
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
  const water = new THREE.MeshStandardMaterial({
    color: '#568c99',
    transparent: true,
    opacity: 0.23,
    roughness: 0.06,
    metalness: 0.35,
    depthWrite: false,
  });
  // A knotted mesh: lit cord on a transparent ground, so it reads as rope rather than a wireframe.
  const netCanvas = document.createElement('canvas');
  netCanvas.width = netCanvas.height = 128;
  const net2d = netCanvas.getContext('2d');
  net2d.strokeStyle = '#fff';
  net2d.lineWidth = 7;
  net2d.beginPath();
  for (const o of [-128, 0, 128]) {
    net2d.moveTo(o, 0);
    net2d.lineTo(o + 128, 128);
    net2d.moveTo(o + 128, 0);
    net2d.lineTo(o, 128);
  }
  net2d.stroke();
  net2d.fillStyle = '#fff';
  for (const [x, y] of [
    [0, 0],
    [128, 0],
    [0, 128],
    [128, 128],
    [64, 64],
  ]) {
    net2d.beginPath();
    net2d.arc(x, y, 7, 0, Math.PI * 2);
    net2d.fill();
  }
  const netTexture = new THREE.CanvasTexture(netCanvas);
  netTexture.wrapS = netTexture.wrapT = THREE.RepeatWrapping;
  netTexture.repeat.set(12, 4);
  const cord = new THREE.MeshStandardMaterial({
    color: '#bfae86',
    roughness: 1,
    alphaMap: netTexture,
    alphaTest: 0.45,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const rope = new THREE.MeshStandardMaterial({ color: '#b9a985', roughness: 0.9 });
  materials.push(steel, rubber, orange, cord, rope, water);
  const disposables = [netTexture];
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
  // Lift each lying object so its lowest point just touches the floor.
  const restLift = {};
  const probe = new THREE.Box3();
  for (const [id, o] of Object.entries(objects)) {
    o.castShadow = true;
    restQuaternion(id, 0, o.quaternion);
    o.position.set(0, 0, 0);
    o.updateMatrixWorld(true);
    restLift[id] = 0.004 - probe.setFromObject(o, true).min.y;
    o.visible = false;
    scene.add(o);
  }
  const heldShield = shield();
  heldShield.visible = false;
  scene.add(heldShield);
  // Plate fragments for the moment a raised shield takes its one hit.
  const shards = Array.from({ length: 6 }, (_, i) => {
    const shard = box(
      scene,
      i === 5 ? [0.2, 0.04, 0.05] : [0.12 + (i % 3) * 0.03, 0.15 + (i % 2) * 0.05, 0.05],
      [0, 0, 0],
      i === 5 ? orange : steel,
    );
    shard.visible = false;
    return shard;
  });
  const shardStart = new THREE.Vector3();
  let shardsArmed = null;
  const heldGrabber = grabber();
  hand.add(heldGrabber);
  heldGrabber.rotation.x = Math.PI / 2;
  heldGrabber.visible = false;
  // The crowbar continues the forearm so its hooked tip meets the door seam.
  const crowbar = new THREE.Group();
  rightHand.add(crowbar);
  crowbar.position.set(0, -0.03, 0.02);
  crowbar.rotation.set(Math.PI + 0.35, 0, 0.55);
  box(crowbar, [0.04, 0.52, 0.04], [0, 0.2, 0.03], steel);
  const hook = box(crowbar, [0.13, 0.04, 0.04], [0.045, 0.46, 0.03], steel);
  hook.rotation.z = -0.25;
  box(crowbar, [0.048, 0.16, 0.048], [0, 0.08, 0.03], orange);
  crowbar.visible = false;
  // A soft net that sags around the legs; drawstring rings keep its shape legible.
  const net = new THREE.Group();
  scene.add(net);
  net.visible = false;
  const netGeometry = new THREE.CylinderGeometry(0.31, 0.27, 0.66, 28, 8, true);
  const netPosition = netGeometry.attributes.position;
  for (let i = 0; i < netPosition.count; i++) {
    const x = netPosition.getX(i),
      y = netPosition.getY(i),
      z = netPosition.getZ(i),
      u = (y + 0.33) / 0.66,
      angle = Math.atan2(z, x);
    // Cinched at the ankles, bulging over the knees, with irregular slack.
    const radial =
      0.78 +
      u * 0.22 +
      Math.sin(u * Math.PI) * 0.2 +
      Math.sin(angle * 3 + u * 5) * 0.05 * Math.sin(u * Math.PI);
    netPosition.setXYZ(
      i,
      x * radial,
      y - (Math.sin(angle * 2) * 0.03 + Math.sin(angle * 5) * 0.015) * u,
      z * radial * 0.86,
    );
  }
  netGeometry.computeVertexNormals();
  const netMesh = new THREE.Mesh(netGeometry, cord);
  netMesh.position.y = 0.42;
  net.add(netMesh);
  for (const [y, r] of [
    [0.1, 0.21],
    [0.75, 0.31],
  ]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 40), rope);
    ring.rotation.x = Math.PI / 2;
    ring.scale.y = 0.86;
    ring.position.y = y;
    ring.castShadow = true;
    net.add(ring);
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
    start = new THREE.Vector3(),
    rest = new THREE.Quaternion(),
    spin = new THREE.Quaternion(),
    netLaunch = new THREE.Vector3(1.5, 0.85, -1.8);
  const zoneYaw = (zone) => Object.keys(ROOM_POINTS).indexOf(zone) * 0.7 + 0.3;
  function restPose(id, zone, position, quaternion) {
    const p = floorRestPoint(id, zone);
    position.set(p[0], restLift[id], p[1]);
    restQuaternion(id, zoneYaw(zone), quaternion);
  }
  return {
    objects,
    // World-space resting point of a floor object, for facing and reaching.
    restPosition(id, zone, target = new THREE.Vector3()) {
      restPose(id, zone, target, rest);
      return target;
    },
    // seconds: wall-clock length of the event, for fragment ballistics.
    update(s, ev, t, impactAt = 0.4, seconds = 1, time = 0, launcher = null) {
      const active = Boolean(ev?.valid) && t < 1;
      for (const [id, mesh] of Object.entries(objects)) {
        const current = s.room.floorObjects?.[id],
          before = ev?.before?.room.floorObjects?.[id];
        const taking = Boolean(
          active &&
          before &&
          !current &&
          ((ev.action === 'pick_up' && ev.args?.object === id) || ev.action === 'recover_item'),
        );
        mesh.visible = Boolean(current || (taking && t < 0.7));
        if (!mesh.visible) continue;
        restPose(id, (current || before).zone, end, rest);
        mesh.position.copy(end);
        mesh.quaternion.copy(rest);
        if (active && current && !before && ['original', 'pistol'].includes(id)) {
          const h = ev.before.human.position;
          start.set(h[0], 0.95, h[1]);
          const dropAt = ev.kind === 'robot' ? impactAt : 0.35;
          const u = THREE.MathUtils.clamp((t - dropAt) / Math.max(0.05, 1 - dropAt), 0, 1),
            fall = u * u;
          mesh.visible = t >= dropAt;
          mesh.position.lerpVectors(start, end, fall);
          mesh.position.y += Math.sin(u * Math.PI) * 0.12;
          mesh.quaternion.multiply(spin.setFromAxisAngle(X, (1 - fall) * Math.PI));
        }
        if (taking && ev.action === 'recover_item') {
          // G-01's telescoping arm reaches it at 0.42 and sets it on the shelf by 0.7.
          if (robotHand && t > 0.42) {
            robotHand.getWorldPosition(mesh.position);
            mesh.position.y -= 0.14;
          }
        } else if (taking) {
          hand.getWorldPosition(start);
          mesh.position.lerp(start, THREE.MathUtils.smoothstep(t, 0.2, 0.7));
        }
      }
      const blocked = Boolean(ev?.valid && ev.shieldBlocked);
      const breakAt = impactAt + 0.12 / Math.max(0.3, seconds);
      heldShield.visible = Boolean(s.human.shieldRaised || (blocked && t < breakAt));
      // Follow the grip, but keep the plate upright rather than inheriting the bent wrist.
      hand.getWorldPosition(heldShield.position);
      heldShield.position.y += 0.16;
      heldShield.position.x += Math.sin(human.rotation.y) * 0.1;
      heldShield.position.z += Math.cos(human.rotation.y) * 0.1;
      const bend = blocked && t > impactAt ? THREE.MathUtils.smoothstep(t, impactAt, breakAt) : 0;
      heldShield.rotation.set(-bend * 0.35, human.rotation.y, bend * 0.12);
      heldShield.scale.set(1 - bend * 0.12, 1, 1 + bend * 0.5);
      if (blocked && t >= breakAt && shardsArmed !== ev.id) {
        shardsArmed = ev.id;
        shardStart.copy(heldShield.position);
      }
      // Fragments settle and stay on the floor until the next event.
      const shattered = blocked && shardsArmed === ev.id;
      shards.forEach((shard, i) => {
        shard.visible = shattered;
        if (!shattered) return;
        const elapsed = Math.max(0, (t - breakAt) * seconds),
          flight = Math.min(elapsed, 0.55),
          angle = i * 2.39996 + human.rotation.y,
          speed = 0.5 + (i % 3) * 0.25;
        shard.position.set(
          shardStart.x + Math.sin(angle) * speed * flight,
          Math.max(
            0.03,
            shardStart.y + (1.2 + (i % 2) * 0.6) * elapsed - 4.905 * elapsed * elapsed,
          ),
          shardStart.z + Math.cos(angle) * speed * flight,
        );
        const tumble = Math.min(elapsed, 0.5);
        shard.rotation.set(tumble * (5 + i), tumble * 3, tumble * (2 + i));
      });
      heldGrabber.visible = active && ev.action === 'pick_up' && Boolean(s.human.grabber);
      crowbar.visible = active && ev.action === 'pry_safe';
      net.visible = Boolean(s.human.restrained || (active && ev.action === 'struggle'));
      net.position.copy(human.position);
      net.rotation.set(0, human.rotation.y + Math.sin(time * 0.0017) * 0.04, 0);
      net.scale.setScalar(1);
      if (active && ev.action === 'deploy_net') {
        // Launched from G-01's raised hand, then it wraps the legs.
        if (launcher && t < 0.16) launcher.getWorldPosition(netLaunch);
        const u = THREE.MathUtils.smoothstep(t, 0.16, 0.6);
        net.position.lerpVectors(netLaunch, human.position, u);
        net.position.y += Math.sin(u * Math.PI) * 0.25 - (1 - u) * 0.3;
        net.scale.set(0.35 + 0.65 * u, 0.25 + 0.75 * u, 0.35 + 0.65 * u);
        net.rotation.y += (1 - u) * 2.4;
      }
      if (active && ev.action === 'struggle') {
        net.scale.set(1 + t * 0.5, 1 - t * 0.55, 1 + t * 0.5);
        net.position.y -= t * 0.08;
        net.visible = t < 0.8;
      }
      // A slipping step is still standing in the water it slipped on.
      for (const [zone, p] of Object.entries(puddles)) {
        const until = s.room.wetZones?.[zone] ?? -1;
        p.visible = until > s.turn || Boolean(ev?.slipped && t < 1 && until >= s.turn);
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
