/**
 * The store's RF-cable / PPG / delete actions are calls to the backend.
 *
 * Wave 3b moved every one of these flows to `POST /api/v3/rf-cables/*`,
 * `/api/v3/ppg/attach` and `/api/v3/objects/delete` (the geometry, the drop
 * rules, the cable-variant pick, the PPG naming and the whole delete cascade
 * are `backend/app/optical/rf_cables/` + `app/services/object_delete.py`, and
 * are pinned there by fixtures and DB tests). What is only reachable HERE is
 * the wiring, and each of these is a way it can look like it works and not:
 *
 *   W1. the REQUEST carries what the endpoint needs (the ports as
 *       `{objectId, anchorName, anchorId}`, the active collection);
 *   W2. the RESPONSE lands in the store, so the user sees the new cable / PPG
 *       / deletion before the websocket event arrives;
 *   W3. a REFUSED rule (4xx, the cases the browser gates used to swallow)
 *       is the old silent no-op — null, and nothing written locally — while a
 *       real outage still throws;
 *   W4. a delete folds objects, PhysicsElements, TimingPrograms, relations
 *       and the SELECTION in one commit — the part no endpoint can do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RfFlowError } from "../../api/client";
import type { SceneData, SceneObject, TimingProgram } from "../../types/digitalTwin";

const rfCableConnectApiMock = vi.fn();
const rfCableDisconnectApiMock = vi.fn();
const rfCableResnapApiMock = vi.fn();
const rfCableAlignCandidatesApiMock = vi.fn();
const rfCableAlignApiMock = vi.fn();
const ppgAttachApiMock = vi.fn();
const deleteObjectsApiMock = vi.fn();

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rfCableConnectApi: (...a: unknown[]) => rfCableConnectApiMock(...a),
  rfCableDisconnectApi: (...a: unknown[]) => rfCableDisconnectApiMock(...a),
  rfCableResnapApi: (...a: unknown[]) => rfCableResnapApiMock(...a),
  rfCableAlignCandidatesApi: (...a: unknown[]) => rfCableAlignCandidatesApiMock(...a),
  rfCableAlignApi: (...a: unknown[]) => rfCableAlignApiMock(...a),
  ppgAttachApi: (...a: unknown[]) => ppgAttachApiMock(...a),
  deleteObjectsApi: (...a: unknown[]) => deleteObjectsApiMock(...a),
}));

const { useSceneStore } = await import("../sceneStore");

const refusal = (code: string, status = 422) => new RfFlowError(status, code, `${code} happened`);

const obj = (id: string, extra: Record<string, unknown> = {}): SceneObject => ({
  id,
  name: id.toUpperCase(),
  componentId: `comp-${id}`,
  xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
  visible: true,
  locked: false,
  properties: {},
  ...extra,
} as unknown as SceneObject);

const pe = (objectId: string, elementKind: string, kindParams: Record<string, unknown> = {}) =>
  ({ id: `pe-${objectId}`, objectId, elementKind, kindParams }) as never;

function seed(): void {
  useSceneStore.setState({
    activeCollectionId: "collection-1",
    selectedObjectId: "sw",
    selectedObjectIds: ["sw", "amp"],
    selectedComponentId: "comp-sw",
    scene: {
      ...useSceneStore.getState().scene,
      objects: [obj("dds"), obj("sw"), obj("amp"), obj("cable"), obj("ppg")],
      physicsElements: [
        pe("dds", "rf_source"),
        pe("sw", "rf_switch"),
        pe("amp", "rf_amplifier"),
        pe("cable", "rf_cable"),
        pe("ppg", "programmable_pulse_generator", { timingProgramId: "tp-ppg" }),
      ],
      timingPrograms: [{ id: "tp-ppg", name: "CH0", intervals: [] }] as unknown as TimingProgram[],
      assemblyRelations: [
        { id: "rel", objectAId: "sw", objectBId: "amp" },
        { id: "rel-other", objectAId: "dds", objectBId: "amp" },
      ] as unknown as SceneData["assemblyRelations"],
      components: [],
      componentBindings: [],
      assets: [],
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

const scene = () => useSceneStore.getState().scene;

describe("createRfCableBetweenPorts → POST /api/v3/rf-cables/connect", () => {
  it("names both ports and the active collection, and shows the new cable (W1, W2)", async () => {
    rfCableConnectApiMock.mockResolvedValue(obj("new-cable"));
    const id = await useSceneStore.getState().createRfCableBetweenPorts({
      srcObjectId: "dds", srcAnchorId: "rf_out", srcAnchorName: "CH0",
      tgtObjectId: "amp", tgtAnchorId: "rf_in", tgtAnchorName: "rf_in",
    });
    expect(id).toBe("new-cable");
    expect(rfCableConnectApiMock).toHaveBeenCalledWith({
      a: { objectId: "dds", anchorName: "CH0", anchorId: "rf_out" },
      b: { objectId: "amp", anchorName: "rf_in", anchorId: "rf_in" },
      collectionId: "collection-1",
    });
    expect(scene().objects.map((o) => o.id)).toContain("new-cable");
  });

  it("a refused drop rule is the old silent null (W3)", async () => {
    rfCableConnectApiMock.mockRejectedValue(refusal("port_busy", 409));
    const before = scene().objects.length;
    expect(await useSceneStore.getState().createRfCableBetweenPorts({
      srcObjectId: "dds", srcAnchorId: "rf_out", srcAnchorName: "CH0",
      tgtObjectId: "amp", tgtAnchorId: "rf_in", tgtAnchorName: "rf_in",
    })).toBeNull();
    expect(scene().objects).toHaveLength(before);
  });

  it("an outage still throws (W3)", async () => {
    rfCableConnectApiMock.mockRejectedValue(new Error("Network Error"));
    await expect(useSceneStore.getState().createRfCableBetweenPorts({
      srcObjectId: "dds", srcAnchorId: "rf_out", srcAnchorName: "CH0",
      tgtObjectId: "amp", tgtAnchorId: "rf_in", tgtAnchorName: "rf_in",
    })).rejects.toThrow("Network Error");
  });
});

describe("the cable align pair", () => {
  it("passes the tolerance through and hands the candidates back verbatim (W1)", async () => {
    rfCableAlignCandidatesApiMock.mockResolvedValue([{ distMm: 3 }]);
    const list = await useSceneStore.getState().findRfCableAlignmentCandidates("cable", "B", 40);
    expect(rfCableAlignCandidatesApiMock).toHaveBeenCalledWith("cable", "B", 40);
    expect(list).toEqual([{ distMm: 3 }]);
  });

  it("answers [] for a target the endpoint refuses (W3)", async () => {
    rfCableAlignCandidatesApiMock.mockRejectedValue(refusal("not_an_rf_cable"));
    expect(await useSceneStore.getState().findRfCableAlignmentCandidates("sw", "A")).toEqual([]);
  });

  it("applies by NAMING the port, with a window that still contains it (W1)", async () => {
    rfCableAlignApiMock.mockResolvedValue(obj("cable", { properties: { rfCableNodes: [] } }));
    await useSceneStore.getState().applyRfCableAlignmentCandidate("cable", "A", {
      distMm: 91.5,
      newPosMmBody: [1, 2, 3],
      newHandleMmBody: [30, 0, 0],
      targetName: "RF_AMPLIFIER0",
      targetObjectId: "amp",
      targetAnchorName: "rf_in",
      targetAnchorId: "rf_in",
    });
    const [cableId, end, target, toleranceMm] = rfCableAlignApiMock.mock.calls[0];
    expect([cableId, end]).toEqual(["cable", "A"]);
    expect(target).toEqual({ objectId: "amp", anchorName: "rf_in", anchorId: "rf_in" });
    expect(toleranceMm).toBeGreaterThanOrEqual(91.5);
    expect(scene().objects.find((o) => o.id === "cable")?.properties).toEqual({ rfCableNodes: [] });
  });
});

describe("resnapRfCablesLinkedTo → POST /api/v3/rf-cables/resnap", () => {
  it("de-duplicates the moved ids and upserts every row the backend wrote (W1, W2)", async () => {
    rfCableResnapApiMock.mockResolvedValue([
      obj("cable", { properties: { rfCableNodes: ["moved"] } }),
      obj("ppg", { xMm: 42 }),
    ]);
    await useSceneStore.getState().resnapRfCablesLinkedTo(["sw", "sw", "amp"]);
    expect(rfCableResnapApiMock).toHaveBeenCalledWith(["sw", "amp"]);
    expect(scene().objects.find((o) => o.id === "cable")?.properties).toEqual({ rfCableNodes: ["moved"] });
    expect(scene().objects.find((o) => o.id === "ppg")?.xMm).toBe(42);
  });

  it("does not call out at all when nothing moved", async () => {
    await useSceneStore.getState().resnapRfCablesLinkedTo([]);
    expect(rfCableResnapApiMock).not.toHaveBeenCalled();
  });
});

describe("clearRfCableEndpointLink → POST /api/v3/rf-cables/{id}/disconnect", () => {
  it("removes the cable the endpoint deleted, and its cascade (W2)", async () => {
    rfCableDisconnectApiMock.mockResolvedValue({
      object: null, deletedObjectIds: ["cable", "ppg"], deletedTimingProgramIds: ["tp-ppg"],
    });
    await useSceneStore.getState().clearRfCableEndpointLink("cable", "A");
    expect(rfCableDisconnectApiMock).toHaveBeenCalledWith("cable", "A");
    expect(scene().objects.map((o) => o.id)).toEqual(["dds", "sw", "amp"]);
    expect(scene().timingPrograms).toEqual([]);
  });

  it("an end with no link is a no-op the store does not react to (W2)", async () => {
    rfCableDisconnectApiMock.mockResolvedValue({
      object: obj("cable"), deletedObjectIds: [], deletedTimingProgramIds: [],
    });
    await useSceneStore.getState().clearRfCableEndpointLink("cable", "B");
    expect(scene().objects).toHaveLength(5);
  });
});

describe("createPpgAtPort → POST /api/v3/ppg/attach", () => {
  it("sends the gate port and shows the PPG + its program at once (W1, W2)", async () => {
    ppgAttachApiMock.mockResolvedValue({
      object: obj("ppg-new", { name: "CH1" }),
      timingProgram: { id: "tp-new", name: "CH1", intervals: [] },
    });
    const created = await useSceneStore.getState().createPpgAtPort({
      targetObjectId: "sw", targetAnchorId: "ttl_in", targetAnchorName: "TTL",
      targetConnectorFamily: "bnc",
    });
    expect(created).toEqual({ objectId: "ppg-new", timingProgramId: "tp-new" });
    expect(ppgAttachApiMock).toHaveBeenCalledWith({
      target: { objectId: "sw", anchorName: "TTL", anchorId: "ttl_in" },
      collectionId: "collection-1",
    });
    expect(scene().objects.map((o) => o.id)).toContain("ppg-new");
    expect((scene().timingPrograms ?? []).map((p) => p.id)).toContain("tp-new");
    expect(useSceneStore.getState().selectedObjectId).toBe("ppg-new");
  });

  it("a refused port leaves NOTHING behind — no ghost CHn (W3)", async () => {
    ppgAttachApiMock.mockRejectedValue(refusal("port_busy", 409));
    expect(await useSceneStore.getState().createPpgAtPort({
      targetObjectId: "sw", targetAnchorId: "ttl_in", targetAnchorName: "TTL",
      targetConnectorFamily: "bnc",
    })).toBeNull();
    expect(scene().objects).toHaveLength(5);
    expect(scene().timingPrograms).toHaveLength(1);
  });
});

describe("deleteObjects → POST /api/v3/objects/delete", () => {
  it("folds the whole answer — objects, elements, programs, relations, selection (W4)", async () => {
    deleteObjectsApiMock.mockResolvedValue({
      deletedObjectIds: ["sw", "cable", "ppg"],
      deletedTimingProgramIds: ["tp-ppg"],
      refused: [],
    });
    await useSceneStore.getState().deleteObjects(["sw"]);
    expect(deleteObjectsApiMock).toHaveBeenCalledWith(["sw"]);
    expect(scene().objects.map((o) => o.id)).toEqual(["dds", "amp"]);
    expect(scene().physicsElements.map((p) => p.objectId)).toEqual(["dds", "amp"]);
    expect(scene().timingPrograms).toEqual([]);
    expect(scene().assemblyRelations.map((r) => r.id)).toEqual(["rel-other"]);
    // "sw" was the active selection: it goes to the surviving member of the
    // multi-selection rather than to an arbitrary object.
    expect(useSceneStore.getState().selectedObjectId).toBe("amp");
    expect(useSceneStore.getState().selectedObjectIds).toEqual(["amp"]);
  });

  it("deleteObject is the same call with one id", async () => {
    deleteObjectsApiMock.mockResolvedValue({
      deletedObjectIds: ["amp"], deletedTimingProgramIds: [], refused: [],
    });
    await useSceneStore.getState().deleteObject("amp");
    expect(deleteObjectsApiMock).toHaveBeenCalledWith(["amp"]);
    expect(scene().objects.map((o) => o.id)).not.toContain("amp");
  });

  it("a cascade that would reach a locked object deletes nothing (W3)", async () => {
    deleteObjectsApiMock.mockRejectedValue(refusal("locked", 409));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(useSceneStore.getState().deleteObjects(["sw"])).resolves.toBeUndefined();
    expect(scene().objects).toHaveLength(5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an empty request never leaves the browser", async () => {
    await useSceneStore.getState().deleteObjects([]);
    expect(deleteObjectsApiMock).not.toHaveBeenCalled();
  });
});
