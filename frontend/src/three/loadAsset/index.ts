import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { resolveAssetUrl } from "../../api/client";
import type { Asset3D, ComponentItem, DeviceState } from "../../types/digitalTwin";
import { createNewportOpticalTable } from "../photoRoom";

// =============================================================================
// Module load order matters here. There is an unavoidable circular import:
//   index.ts → primitive.ts → kinds/_plugins.ts → _renderer_bindings.ts
//     → ../three/loadAsset (= index.ts)
// _renderer_bindings.ts reads named bindings (createAom, createTaperedAmplifier,
// …) from the barrel at module init to build its RENDERER_BY_COMPONENT_TYPE
// lookup. When the barrel is re-entered mid-load, ONLY the bindings declared
// before the re-entry point have a value — the rest are still `undefined`.
//
// Pre-split, this worked because every renderer was a hoisted `function`
// declaration in the same file. Now they live in sub-modules. We replicate the
// old guarantee by importing EVERY sub-module that contributes a binding
// _renderer_bindings.ts reads BEFORE we import primitive.ts (the entry that
// triggers the cycle).
// =============================================================================

import {
  createBox,
  materialFor,
} from "./materials";
import {
  applyRfCableConnectorTransform,
  createSmaShortCable,
  refreshRfCableWrapperGeometry,
} from "./rf_cable";
import {
  applyFiberConnectorTransform,
  applyFiberFerruleOrientation,
  buildFiberCurvePath,
  createFiberSplineObject,
  fiberEndpointOutwardThree,
  refreshFiberWrapperGeometry,
  type FiberEndPlacement,
  type FiberNode,
} from "./fiber";
import {
  buildAd9959PcbObject,
  buildBB1E03MirrorObject,
  buildPbs252BeamSplitterObject,
  buildWphsm05WaveplateObject,
  isAd9959PcbAsset,
  isBB1E03Asset,
  isPbs252Asset,
  isWphsm05Asset,
} from "./stl_builders";
import {
  buildIsolatorPbsOverlay,
  buildThorlabsIsolatorObject,
  isThorlabsIsolatorAsset,
} from "../../kinds/isolator/pbsOverlay";

// Passive renderers (no per-kind folder). MUST load before primitive.ts.
import {
  createThorlabsClampingFork,
  createThorlabsPedestalPost,
  createThorlabsPost,
  createThorlabsPostHolder,
  createTs2000aLaserMount,
} from "./passive/mechanical";
import {
  createDdsMcuBoard,
  createDdsTcxoModule,
  createIecC14Inlet,
  createInstrumentChassis1u,
  createMeanwellIrm30,
  createSmaBulkheadJack,
  createUsbBJack,
} from "./passive/electronics";
import { createTextAnnotation } from "./passive/text_annotation";

// Per-kind renderers. MUST load before primitive.ts.
import { createAom } from "../../kinds/aom/renderer";
import { createTaperedAmplifier } from "../../kinds/tapered_amplifier/renderer";
import { createZhl12wPlusAmplifier } from "../../kinds/rf_amplifier/renderer";
import { createRfSwitch } from "../../kinds/rf_switch/renderer";
import { createDdsAd9959Pcb } from "../../kinds/rf_source/renderer";

// Cycle trigger — by this line every binding _renderer_bindings.ts reads from
// the barrel has been initialised, so it sees real values, not `undefined`.
import { applyAssetScale, createPrimitive } from "./primitive";

const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();
const stlLoader = new STLLoader();

export async function loadAssetObject(
  component: ComponentItem,
  asset: Asset3D | undefined,
  state: DeviceState | undefined,
  /** Per-instance properties — V2: each scene object can have its own
   *  fiberNodes / rfCableNodes / radiusMm overrides on top of the
   *  component's catalog defaults. Pass `sceneObject.properties` from
   *  the caller. */
  objectProperties?: {
    fiberNodes?: FiberNode[];
    rfCableNodes?: FiberNode[];
    radiusMm?: number;
  } | null,
  /** Per-instance fiber endpoint pose (alembic 0056). When provided,
   *  the fiber ferrules render at the supplied body-local poses
   *  (decoupled from spline tangent). Caller (DigitalTwinViewer
   *  createComponentMesh) reads these from fiber PE kindParams.endA /
   *  endB. */
  instanceFlags?: {
    fiberEndA?: FiberEndPlacement | null;
    fiberEndB?: FiberEndPlacement | null;
  } | null,
): Promise<THREE.Object3D> {
  if (component.componentType === "optical_table") {
    const table = createNewportOpticalTable();
    table.name = component.name;
    return table;
  }

  // Fiber patch cables render procedurally as a Bezier-spline tube using
  // user-editable anchor + tangent-handle data. Per V2 the spline shape is
  // a per-instance property (objects.properties.fiberNodes); the catalog
  // template's component.properties.fiberNodes is the legacy fallback for
  // pre-2026-05-11 rows. The two ferrules are placed at body-local
  // poses from fiber PE.kindParams.endA / endB (alembic 0056).
  if (component.componentType === "fiber") {
    const wrapper = new THREE.Group();
    wrapper.name = component.name;
    wrapper.add(createFiberSplineObject(
      component,
      objectProperties?.fiberNodes,
      objectProperties?.radiusMm,
      instanceFlags?.fiberEndA ?? null,
      instanceFlags?.fiberEndB ?? null,
    ));
    return wrapper;
  }
  // alembic 0056: fiber_end SceneObjects no longer exist. The two
  // ferrules render as children of the fiber wrapper above.

  // Phase RF.cable (2026-05-13): rf_cable / sma_cable render through the
  // procedural SMA-cable primitive. When the per-instance SceneObject
  // carries `rfCableNodes` we render the Bezier-spline version (jacket
  // follows the curve, connectors auto-orient to endpoint tangents).
  // Without nodes we fall back to the straight-cylinder rendering — same
  // appearance as before the spline mode landed.
  if (
    component.componentType === "rf_cable" ||
    component.componentType === "sma_cable"
  ) {
    const wrapper = new THREE.Group();
    wrapper.name = component.name;
    wrapper.add(createSmaShortCable(component, state, objectProperties?.rfCableNodes));
    return wrapper;
  }

  if (!asset || asset.filePath.startsWith("primitive://")) {
    return createPrimitive(component, state, asset);
  }

  const assetUrl = resolveAssetUrl(asset.filePath);
  const extension = asset.filePath.split("?")[0].split(".").pop()?.toLowerCase();
  if (!["glb", "gltf", "obj", "stl"].includes(extension ?? "")) {
    return createPrimitive(component, state, asset);
  }
  let object: THREE.Object3D;

  if (extension === "obj") {
    object = (await objLoader.loadAsync(assetUrl)).clone(true);
  } else if (extension === "stl") {
    const geometry = await stlLoader.loadAsync(assetUrl);
    geometry.computeVertexNormals();
    if (isBB1E03Asset(asset)) {
      object = buildBB1E03MirrorObject(geometry, component);
    } else if (isWphsm05Asset(asset)) {
      object = buildWphsm05WaveplateObject(geometry, component);
    } else if (isPbs252Asset(asset)) {
      object = buildPbs252BeamSplitterObject(geometry, component);
    } else if (isAd9959PcbAsset(asset)) {
      object = buildAd9959PcbObject(geometry, component);
    } else if (isThorlabsIsolatorAsset(asset)) {
      object = buildThorlabsIsolatorObject(geometry, component, asset);
    } else {
      object = new THREE.Mesh(geometry, materialFor(component, state));
    }
  } else {
    object = (await gltfLoader.loadAsync(assetUrl)).scene.clone(true);
  }

  object.name = component.name;
  applyAssetScale(object, asset);

  // Z-fighting on user-supplied GLBs (notably the BoosTA pro housing) where
  // the original CAD has coplanar surfaces — top plate + edge trim sharing
  // a face plane. Two compounding fixes:
  //   1. Force `side: FrontSide`. CAD exporters often default to
  //      DoubleSide which renders BOTH triangle faces; for two coplanar
  //      DoubleSide meshes the GPU has 4 faces (two front, two back) at
  //      the same depth → polygon offset can't fully disambiguate.
  //      Solid bodies only need front-face rendering anyway.
  //   2. Per-mesh polygon offset stratification cycling [0, -3.5] on
  //      mesh index. Even after #1 collapses to 2 front faces, identical
  //      coplanar surfaces still need a deterministic per-mesh bias so
  //      the GPU consistently picks the same winner every frame.
  // Materials are cloned to avoid bleeding the offset across meshes that
  // share a material instance from the GLB.
  let meshSeenIndex = 0;
  object.traverse((child) => {
    child.castShadow = true;
    child.receiveShadow = true;
    if (child instanceof THREE.Mesh && child.material) {
      const offsetMagnitude = (meshSeenIndex % 8) * 0.5;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const cloned = materials.map((m) => {
        const c = m.clone();
        c.side = THREE.FrontSide;
        c.polygonOffset = true;
        c.polygonOffsetFactor = -offsetMagnitude;
        c.polygonOffsetUnits = -offsetMagnitude;
        return c;
      });
      child.material = Array.isArray(child.material) ? cloned : cloned[0];
      meshSeenIndex += 1;
    }
  });

  // Anchor strategy: STL/GLB authors put the local origin wherever they
  // want, so we shift the loaded object inside a wrapper Group so a
  // semantically-meaningful point lands at the wrapper origin. Downstream
  // code calls applyObjectTransform on the wrapper, which means user-set
  // (xMm, yMm, zMm) lands the chosen anchor at exactly that lab position.
  //
  // Two anchors supported:
  //   1. apertureForwardLocalMm (in component.properties): user-supplied
  //      [bx, by, bz] in Blender's NATIVE frame (X right, Y forward, Z up,
  //      mm). Used for emitter components like the BoosTA pro TA — places
  //      the OUTPUT APERTURE at the wrapper origin so the SceneObject's
  //      lab position equals the BEAM EMISSION POINT. Lets the user place
  //      the TA at a known beam-line coordinate without compensating for
  //      bbox geometry.
  //   2. Default: bbox center → wrapper origin. Sensible fallback for
  //      arbitrary catalog assets where we don't have semantic anchors.
  // Optical-table is excluded — it's already anchored at its top-surface
  // centre by createNewportOpticalTable.
  if (component.componentType !== "optical_table") {
    const wrapper = new THREE.Group();
    wrapper.name = component.name;
    wrapper.add(object);
    // Phase 6: prefer the new frame-suffixed key
    // (`apertureForwardMmBodyLocal`), fall back to legacy
    // `apertureForwardLocalMm` for un-migrated rows.
    const apertureProps = component.properties as
      | { apertureForwardMmBodyLocal?: number[]; apertureForwardLocalMm?: number[] }
      | undefined;
    const apertureForward = apertureProps?.apertureForwardMmBodyLocal
      ?? apertureProps?.apertureForwardLocalMm;
    if (apertureForward && apertureForward.length === 3) {
      // Blender (X, Y, Z) → glTF/three (X, Z, -Y); mm → three units (÷100).
      // The shift is applied AS POSITION on `object` (which lives in
      // wrapper-local space, no scale), so values are in three units.
      const [bx, by, bz] = apertureForward;
      const apertureShift = new THREE.Vector3(bx, bz, -by).divideScalar(100);
      object.position.sub(apertureShift);
    } else {
      const bbox = new THREE.Box3().setFromObject(object);
      if (!bbox.isEmpty()) {
        const centerVec = bbox.getCenter(new THREE.Vector3());
        object.position.sub(centerVec);
      }
    }
    return wrapper;
  }
  return object;
}

export function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}

// =============================================================================
// Public-API re-exports. Preserved verbatim so external consumers
// (DigitalTwinViewer, ComponentEditor, OpticalLinkViewerPanel,
// _renderer_bindings.ts, kinds/mirror/renderer.ts) keep working without
// touching their `from "../three/loadAsset"` imports.
// =============================================================================

export {
  applyFiberConnectorTransform,
  applyFiberFerruleOrientation,
  applyRfCableConnectorTransform,
  buildFiberCurvePath,
  buildIsolatorPbsOverlay,
  buildThorlabsIsolatorObject,
  createAom,
  createBox,
  createDdsAd9959Pcb,
  createDdsMcuBoard,
  createDdsTcxoModule,
  createIecC14Inlet,
  createInstrumentChassis1u,
  createMeanwellIrm30,
  createRfSwitch,
  createSmaBulkheadJack,
  createSmaShortCable,
  createTaperedAmplifier,
  createTextAnnotation,
  createThorlabsClampingFork,
  createThorlabsPedestalPost,
  createThorlabsPost,
  createThorlabsPostHolder,
  createTs2000aLaserMount,
  createUsbBJack,
  createZhl12wPlusAmplifier,
  fiberEndpointOutwardThree,
  isThorlabsIsolatorAsset,
  materialFor,
  refreshFiberWrapperGeometry,
  refreshRfCableWrapperGeometry,
  type FiberNode,
};
