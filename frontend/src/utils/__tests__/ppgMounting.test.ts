/**
 * PPG mounting tests.
 *
 * A PPG plugs straight into a peer instrument's coax port — no visible
 * cable. `computePpgMountedThreePose` places the PPG body so its own
 * `rf_out` anchor coincides with the target port anchor, facing into it.
 *
 * Invariants:
 *   M1. The mated pose puts the PPG's rf_out exactly on the target anchor.
 *   M2. The PPG's rf_out faces anti-parallel to the target's outward normal.
 *   M3. The target instrument's asset resolves through the ComponentBinding
 *       tree (`primaryAsset`), not the legacy `component.asset3dId`. This is
 *       the regression that made the PPG float at its spawn point in every
 *       binding-backed scene.
 *   M4. No connecting cable / unresolvable peer → null (caller falls back).
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { computePpgMountedThreePose } from "../ppgMounting";
import type {
  Anchor,
  Asset3D,
  ComponentBinding,
  ComponentItem,
  PhysicsElement,
  SceneData,
  SceneObject,
} from "../../types/digitalTwin";

function anchor(id: string, pos: [number, number, number], axisX: [number, number, number], name?: string): Anchor {
  return {
    id,
    ...(name ? { name } : {}),
    positionMmBodyLocal: { x: pos[0], y: pos[1], z: pos[2] },
    axisXBodyLocal: { x: axisX[0], y: axisX[1], z: axisX[2] },
  } as Anchor;
}

function asset(id: string, anchors: Anchor[]): Asset3D {
  return {
    id,
    name: `asset-${id}`,
    assetType: "glb",
    filePath: "",
    unit: "mm",
    scaleFactor: 1.0,
    anchors,
  } as Asset3D;
}

function component(id: string, assetId: string | null): ComponentItem {
  return { id, name: `comp-${id}`, asset3dId: assetId, properties: {} } as unknown as ComponentItem;
}

function binding(componentId: string, asset3dId: string): ComponentBinding {
  return {
    id: `bind-${componentId}`,
    componentId,
    parentBindingId: null,
    targetKind: "asset",
    asset3dId,
    role: "root",
  } as unknown as ComponentBinding;
}

function object(id: string, componentId: string, pose: Partial<SceneObject> = {}): SceneObject {
  return {
    id,
    name: `obj-${id}`,
    componentId,
    xMm: 0, yMm: 0, zMm: 0,
    rxDeg: 0, ryDeg: 0, rzDeg: 0,
    visible: true, locked: false,
    properties: {},
    ...pose,
  } as SceneObject;
}

function pe(objectId: string, elementKind: string): PhysicsElement {
  return { id: `pe-${objectId}`, objectId, elementKind, kindParams: {} } as unknown as PhysicsElement;
}

/** switch at (100, 0, 0) with a ttl_in port 20 mm out along its −X face;
 *  PPG whose rf_out sits 5 mm along its own +X. Cable ties them together.
 *  `hostUsesBinding` picks whether the switch's asset is reachable only
 *  through the binding tree (the real, binding-backed catalog shape). */
function scene(hostUsesBinding: boolean): {
  sceneData: SceneData;
  ppgObject: SceneObject;
  ppgComponent: ComponentItem;
  ppgAsset: Asset3D;
} {
  const hostAsset = asset("host", [anchor("ttl_in", [-20, 0, 0], [-1, 0, 0])]);
  const ppgAsset = asset("ppg", [anchor("rf_out", [5, 0, 0], [1, 0, 0])]);
  const hostComponent = component("comp-host", hostUsesBinding ? null : hostAsset.id);
  const ppgComponent = component("comp-ppg", ppgAsset.id);
  const hostObject = object("host", hostComponent.id, { xMm: 100 });
  const ppgObject = object("ppg", ppgComponent.id, { xMm: -500, yMm: 300 }); // nowhere near
  const cableObject = object("cable", "comp-cable", {
    properties: {
      rfCableEndpoints: {
        A: { targetObjectId: "ppg", targetAnchorId: "rf_out", targetAnchorName: "rf_out" },
        B: { targetObjectId: "host", targetAnchorId: "ttl_in", targetAnchorName: "ttl_in" },
      },
    },
  });
  return {
    sceneData: {
      objects: [hostObject, ppgObject, cableObject],
      components: [hostComponent, ppgComponent, component("comp-cable", null)],
      assets: [hostAsset, ppgAsset],
      componentBindings: hostUsesBinding ? [binding(hostComponent.id, hostAsset.id)] : [],
      physicsElements: [pe("host", "rf_switch"), pe("ppg", "programmable_pulse_generator"), pe("cable", "rf_cable")],
    } as unknown as SceneData,
    ppgObject,
    ppgComponent,
    ppgAsset,
  };
}

/** Re-derive where the PPG's rf_out anchor ends up, given the mated pose.
 *  Anchor body positions are mm; the returned pose is in three units
 *  (mm / 100), so compare in the same space. */
function matedRfOutThree(
  pose: { positionThree: THREE.Vector3; quaternion: THREE.Quaternion },
  ppgAnchorBodyMm: [number, number, number],
): THREE.Vector3 {
  return new THREE.Vector3(...ppgAnchorBodyMm)
    .multiplyScalar(1 / 100)
    .applyQuaternion(pose.quaternion)
    .add(pose.positionThree);
}

describe("computePpgMountedThreePose", () => {
  it("mates rf_out onto the target port, facing into it (M1, M2)", () => {
    const { sceneData, ppgObject, ppgComponent, ppgAsset } = scene(false);
    const pose = computePpgMountedThreePose(sceneData, ppgObject, ppgComponent, ppgAsset);
    expect(pose).not.toBeNull();

    // M1 — the PPG's rf_out lands on the host's ttl_in lab position:
    // host at x=100 mm, port at body −20 mm → lab x = 80 mm = 0.8 three units.
    const rfOut = matedRfOutThree(pose!, [5, 0, 0]);
    expect(rfOut.x).toBeCloseTo(0.8, 6);
    expect(rfOut.y).toBeCloseTo(0, 6);
    expect(rfOut.z).toBeCloseTo(0, 6);

    // M2 — PPG rf_out body +X, rotated, must oppose the port's outward −X.
    const facing = new THREE.Vector3(1, 0, 0).applyQuaternion(pose!.quaternion);
    expect(facing.x).toBeCloseTo(1, 6);
  });

  it("resolves the target asset through the binding tree (M3)", () => {
    // Same geometry, but the host component reaches its Asset3D only via a
    // root ComponentBinding — `component.asset3dId` is null. Before the fix
    // this returned null and the PPG stayed at its spawn pose.
    const { sceneData, ppgObject, ppgComponent, ppgAsset } = scene(true);
    const pose = computePpgMountedThreePose(sceneData, ppgObject, ppgComponent, ppgAsset);
    expect(pose).not.toBeNull();
    const rfOut = matedRfOutThree(pose!, [5, 0, 0]);
    expect(rfOut.x).toBeCloseTo(0.8, 6);
  });

  it("backs the body off by the PPG's own plug protrusion (M6)", () => {
    // The PPG's rf_out anchor sits where the plug leaves the body, not at the
    // face that mates with the port. Without the offset the plug is buried in
    // the instrument. The correction belongs to the PPG (asset-authored),
    // NOT to the shared port anchor which the cable resolver also reads.
    const { sceneData, ppgObject, ppgComponent, ppgAsset } = scene(true);
    const characterised = { ...ppgAsset, defaultParams: { matingProtrusionMm: 9 } } as Asset3D;
    const pose = computePpgMountedThreePose(sceneData, ppgObject, ppgComponent, characterised);
    expect(pose).not.toBeNull();

    // Port is at lab x = 80 mm facing −X; the PPG approaches from −X with its
    // plug pointing +X. The anchor must therefore stop 9 mm SHORT of the port
    // (x = 71 mm) so the plug tip — 9 mm further along the mating axis —
    // lands exactly on the port face instead of 9 mm inside the instrument.
    const rfOut = matedRfOutThree(pose!, [5, 0, 0]);
    expect(rfOut.x).toBeCloseTo(0.8 - 0.09, 6);

    // And the uncharacterised asset is unchanged — no silent guessing.
    const plain = computePpgMountedThreePose(sceneData, ppgObject, ppgComponent, ppgAsset);
    expect(matedRfOutThree(plain!, [5, 0, 0]).x).toBeCloseTo(0.8, 6);
  });

  it("returns null when no cable links the PPG to a peer (M4)", () => {
    const { sceneData, ppgObject, ppgComponent, ppgAsset } = scene(true);
    const orphan = {
      ...sceneData,
      objects: sceneData.objects.filter((o) => o.id !== "cable"),
    } as SceneData;
    expect(computePpgMountedThreePose(orphan, ppgObject, ppgComponent, ppgAsset)).toBeNull();
  });

  it("mates from properties.ppgAttachment with no cable present (M5)", () => {
    // Current model: the PPG plugs straight into the port and the scene holds
    // NO rf_cable for it. The attachment record alone must drive the mount.
    const { sceneData, ppgObject, ppgComponent, ppgAsset } = scene(true);
    const cableless = {
      ...sceneData,
      objects: sceneData.objects
        .filter((o) => o.id !== "cable")
        .map((o) =>
          o.id === "ppg"
            ? {
                ...o,
                properties: {
                  ppgAttachment: {
                    targetObjectId: "host",
                    targetAnchorId: "ttl_in",
                    targetAnchorName: "ttl_in",
                  },
                },
              }
            : o,
        ),
    } as SceneData;
    const attachedPpg = cableless.objects.find((o) => o.id === "ppg")!;
    const pose = computePpgMountedThreePose(cableless, attachedPpg, ppgComponent, ppgAsset);
    expect(pose).not.toBeNull();
    expect(matedRfOutThree(pose!, [5, 0, 0]).x).toBeCloseTo(0.8, 6);
    void ppgObject;
  });

  it("returns null when the PPG asset declares no rf_out (M4)", () => {
    const { sceneData, ppgObject, ppgComponent } = scene(true);
    const noPort = asset("ppg", [anchor("trigger_in", [0, 0, 0], [1, 0, 0])]);
    expect(computePpgMountedThreePose(sceneData, ppgObject, ppgComponent, noPort)).toBeNull();
  });
});
