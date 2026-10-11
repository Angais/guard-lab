import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

// Three's normal override treats transparent labels and particles as solid geometry.
// Exclude those only during the depth/normal pass; keep their normal rendering intact.
export class ContactShadows extends GTAOPass {
  constructor(scene, camera) {
    super(scene, camera, 512, 512);
    this.transparentObjects = [];
    this.updateGtaoMaterial({ radius: 0.18, thickness: 0.06, samples: 8, distanceFallOff: 0.8 });
    this.updatePdMaterial({ radius: 4, samples: 8 });
    this.blendIntensity = 0.85;
  }
  // The scene pass has already refreshed this frame's shadow maps; the normal
  // pass renders the scene again and must not redraw every shadow map.
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const autoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      renderer.shadowMap.autoUpdate = autoUpdate;
    }
  }
  _overrideVisibility() {
    super._overrideVisibility();
    this.scene.traverse((object) => {
      if (object.visible && (object.isSprite || object.material?.transparent)) {
        this.transparentObjects.push(object);
        object.visible = false;
      }
    });
  }
  _restoreVisibility() {
    super._restoreVisibility();
    for (const object of this.transparentObjects) object.visible = true;
    this.transparentObjects.length = 0;
  }
}
