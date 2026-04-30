import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { useSceneStore } from "../store/sceneStore";
import { createBeamPath } from "../three/beamPath";
import { disposeObject, loadAssetObject } from "../three/loadAsset";
import { createLabPhotoRoom } from "../three/photoRoom";
import { applyPlacement } from "../three/transformUtils";
import { relationTarget, worldAnchor } from "../utils/relationAnchors";

const SHOW_DATABASE_COMPONENTS = true;
const SHOW_BEAM_PATHS = false;

type RoomDimensions = {
  widthMm: number;
  depthMm: number;
  heightMm: number;
};

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function addSelectionMarker(object: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(0.48, Math.min(19, Math.max(size.x, size.z) * 0.52));
  const marker = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.018, 10, 120),
    new THREE.MeshBasicMaterial({
      color: "#38bdf8",
      transparent: true,
      opacity: 0.95,
    }),
  );
  marker.name = "selection-marker";
  marker.rotation.x = Math.PI / 2;
  marker.position.y = 0.035;
  object.add(marker);
}

function addObjectAxesHelper(object: THREE.Object3D, isDriven = false): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z, 1);

  const axes = new THREE.AxesHelper(Math.max(1.2, maxSize * 0.72));
  axes.name = isDriven ? "relation-driven-axes" : "relation-driver-axes";

  const center = box.getCenter(new THREE.Vector3());
  const localCenter = object.worldToLocal(center.clone());
  axes.position.copy(localCenter);

  object.add(axes);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(Math.max(0.5, maxSize * 0.5), 0.025, 10, 120),
    new THREE.MeshBasicMaterial({
      color: isDriven ? "#f97316" : "#22c55e",
      transparent: true,
      opacity: 0.95,
    }),
  );

  ring.name = isDriven ? "relation-driven-marker" : "relation-driver-marker";
  ring.rotation.x = Math.PI / 2;
  ring.position.copy(localCenter);
  object.add(ring);
}

function labToThree(point: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(point.x / 100, point.z / 100, -point.y / 100);
}

function directionToThree(direction?: { x: number; y: number; z: number }): THREE.Vector3 | null {
  if (!direction) return null;
  const vector = new THREE.Vector3(direction.x, direction.z, -direction.y);
  return vector.lengthSq() > 0 ? vector.normalize() : null;
}

function addAnchorAxis(
  group: THREE.Group,
  origin: THREE.Vector3,
  direction: { x: number; y: number; z: number } | undefined,
  color: string,
): void {
  const axis = directionToThree(direction);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 12, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
  dot.position.copy(origin);
  group.add(dot);
  if (!axis) return;
  const arrow = new THREE.ArrowHelper(axis, origin, 0.75, color, 0.18, 0.08);
  group.add(arrow);
}

function createAxisLabel(text: string, color: string, position: THREE.Vector3): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;
    context.beginPath();
    context.arc(48, 48, 30, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "700 42px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 48, 50);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.position.copy(position);
  sprite.scale.set(0.32, 0.32, 0.32);
  return sprite;
}

function createGlobalAxesGizmo(): THREE.Group {
  const group = new THREE.Group();
  const axes = [
    { label: "X", color: "#ef4444", direction: new THREE.Vector3(1, 0, 0) },
    { label: "Y", color: "#22c55e", direction: new THREE.Vector3(0, 0, -1) },
    { label: "Z", color: "#3b82f6", direction: new THREE.Vector3(0, 1, 0) },
  ];

  group.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 16, 16),
      new THREE.MeshBasicMaterial({ color: "#f8fafc" }),
    ),
  );

  for (const axis of axes) {
    group.add(new THREE.ArrowHelper(axis.direction, new THREE.Vector3(0, 0, 0), 1, axis.color, 0.22, 0.11));
    group.add(createAxisLabel(axis.label, axis.color, axis.direction.clone().multiplyScalar(1.22)));
  }

  return group;
}

type DigitalTwinViewerProps = {
  roomDimensions: RoomDimensions;
};

export function DigitalTwinViewer({ roomDimensions }: DigitalTwinViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const orientationRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const environmentGroupRef = useRef<THREE.Group | null>(null);
  const componentGroupRef = useRef<THREE.Group>(new THREE.Group());
  const beamGroupRef = useRef<THREE.Group>(new THREE.Group());
  const relationGroupRef = useRef<THREE.Group>(new THREE.Group());
  const globalAxesGizmoRef = useRef<THREE.Group | null>(null);
  const animationFrameRef = useRef<number>();

  const sceneData = useSceneStore((state) => state.scene);
  const selectedComponentId = useSceneStore((state) => state.selectedComponentId);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectedRelationId = useSceneStore((state) => state.selectedRelationId);
  const previewObjectTransforms = useSceneStore((state) => state.previewObjectTransforms);
  const relationDraftTarget = useSceneStore((state) => state.relationDraftTarget);
  const selectObject = useSceneStore((state) => state.selectObject);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#151715");
    scene.fog = new THREE.Fog("#151715", 45, 90);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
    camera.position.set(28, 16, 19);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const orientationScene = new THREE.Scene();
    const orientationCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 8);
    orientationCamera.position.set(0, 0, 3.6);
    const orientationRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    orientationRenderer.outputColorSpace = THREE.SRGBColorSpace;
    orientationRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    orientationRenderer.setSize(112, 112, false);
    orientationRenderer.domElement.className = "global-axis-gizmo";
    mount.appendChild(orientationRenderer.domElement);
    orientationRendererRef.current = orientationRenderer;
    const globalAxesGizmo = createGlobalAxesGizmo();
    globalAxesGizmoRef.current = globalAxesGizmo;
    orientationScene.add(globalAxesGizmo);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 5.2, 0);
    controlsRef.current = controls;

    const ambient = new THREE.AmbientLight("#ffffff", 1.08);
    const key = new THREE.DirectionalLight("#ffffff", 2.05);
    key.position.set(16, 22, 14);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -24;
    key.shadow.camera.right = 24;
    key.shadow.camera.top = 18;
    key.shadow.camera.bottom = -18;
    const environmentGroup = createLabPhotoRoom(roomDimensions);
    environmentGroupRef.current = environmentGroup;
    scene.add(environmentGroup, ambient, key);

    componentGroupRef.current.name = "components";
    beamGroupRef.current.name = "beam-paths";
    relationGroupRef.current.name = "relations";
    scene.add(componentGroupRef.current, beamGroupRef.current, relationGroupRef.current);

    const resize = () => {
      const width = Math.max(mount.clientWidth, 320);
      const height = Math.max(mount.clientHeight, 260);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const handlePointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(componentGroupRef.current.children, true);
      const hit = hits.find((item) => item.object.userData.objectId);
      selectObject(hit ? String(hit.object.userData.objectId) : null);
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);

    const animate = () => {
      controls.update();
      if (environmentGroupRef.current) {
        const halfWidth = roomDimensions.widthMm / 200;
        const halfDepth = roomDimensions.depthMm / 200;
        for (const wall of environmentGroupRef.current.children) {
          const material = wall instanceof THREE.Mesh ? wall.material : null;
          if (!(material instanceof THREE.MeshStandardMaterial) || !wall.userData.fadeWhenBlocking) continue;
          const side = wall.userData.roomSide;
          const isBlocking =
            (side === "left" && camera.position.x < -halfWidth) ||
            (side === "right" && camera.position.x > halfWidth) ||
            (side === "back" && camera.position.z < -halfDepth) ||
            (side === "ceiling" && camera.position.y > roomDimensions.heightMm / 100);
          material.opacity = isBlocking ? 0.22 : 0.9;
          material.transparent = true;
          material.depthWrite = !isBlocking;
          material.needsUpdate = true;
        }
      }
      renderer.render(scene, camera);
      if (globalAxesGizmoRef.current) {
        globalAxesGizmoRef.current.quaternion.copy(camera.quaternion).invert();
      }
      orientationRenderer.render(orientationScene, orientationCamera);
      animationFrameRef.current = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      clearGroup(componentGroupRef.current);
      clearGroup(beamGroupRef.current);
      clearGroup(relationGroupRef.current);
      if (environmentGroupRef.current) {
        scene.remove(environmentGroupRef.current);
        disposeObject(environmentGroupRef.current);
        environmentGroupRef.current = null;
      }
      controls.dispose();
      renderer.dispose();
      orientationRenderer.dispose();
      orientationRenderer.domElement.remove();
      disposeObject(orientationScene);
      renderer.domElement.remove();
      scene.clear();
    };
  }, [roomDimensions, selectObject]);

  useEffect(() => {
    let cancelled = false;
    const componentGroup = componentGroupRef.current;
    const beamGroup = beamGroupRef.current;
    const relationGroup = relationGroupRef.current;

    clearGroup(componentGroup);
    clearGroup(beamGroup);
    clearGroup(relationGroup);

    const assetById = new Map(sceneData.assets.map((asset) => [asset.id, asset]));
    const componentById = new Map(sceneData.components.map((component) => [component.id, component]));
    const stateByComponentId = new Map(
      sceneData.deviceStates.map((deviceState) => [deviceState.componentId, deviceState]),
    );
    const selectedRelation = selectedRelationId
      ? sceneData.assemblyRelations.find((relation) => relation.id === selectedRelationId)
      : undefined;

    const selectedRelationObjectIds = selectedRelation
      ? new Set([selectedRelation.objectAId, selectedRelation.objectBId])
      : new Set<string>();
    const draftRelationObjectIds = relationDraftTarget
      ? new Set([relationDraftTarget.objectAId, relationDraftTarget.objectBId])
      : new Set<string>();

    const selectedDrivenObjectId = selectedRelation
      ? String(selectedRelation.properties?.drivenObjectId ?? selectedRelation.objectBId)
      : null;

    if (!SHOW_DATABASE_COMPONENTS && !SHOW_BEAM_PATHS) {
      return () => {
        cancelled = true;
        clearGroup(componentGroup);
        clearGroup(beamGroup);
      };
    }

    async function renderComponents() {
      if (!SHOW_DATABASE_COMPONENTS) return;

      for (const placement of sceneData.objects) {
        const preview = previewObjectTransforms[placement.id];
        const effectivePlacement = preview ? { ...placement, ...preview } : placement;
        const component = componentById.get(placement.componentId);
        if (!component) continue;
        if (!placement || !placement.visible) continue;

        const asset = component.asset3dId ? assetById.get(component.asset3dId) : undefined;
        const deviceState = stateByComponentId.get(component.id);
        const object = await loadAssetObject(component, asset, deviceState);

        if (cancelled) {
          disposeObject(object);
          return;
        }

        object.userData.componentId = component.id;
        object.userData.objectId = placement.id;
        object.traverse((child) => {
          child.userData.componentId = component.id;
          child.userData.objectId = placement.id;
        });
        applyPlacement(object, effectivePlacement);

        if (component.id === selectedComponentId || placement.id === selectedObjectId) {
          addSelectionMarker(object);
        }

        if (selectedRelationObjectIds.has(placement.id) || draftRelationObjectIds.has(placement.id)) {
          addObjectAxesHelper(
            object,
            placement.id === selectedDrivenObjectId || placement.id === relationDraftTarget?.objectBId,
          );
        }

        componentGroup.add(object);
      }
    }

    function renderRelations() {
      const objectById = new Map(
        sceneData.objects.map((object) => [
          object.id,
          previewObjectTransforms[object.id] ? { ...object, ...previewObjectTransforms[object.id] } : object,
        ]),
      );
      for (const relation of sceneData.assemblyRelations) {
        if (!relation.enabled) continue;
        const targetA = relationTarget(relation, "a");
        const targetB = relationTarget(relation, "b");
        const objectA = objectById.get(targetA.objectId);
        const objectB = objectById.get(targetB.objectId);
        if (!objectA || !objectB) continue;
        const compA = componentById.get(objectA.componentId);
        const compB = componentById.get(objectB.componentId);
        const anchorA = worldAnchor(objectA, compA, targetA.anchorId, compA?.asset3dId ? assetById.get(compA.asset3dId) : null);
        const anchorB = worldAnchor(objectB, compB, targetB.anchorId, compB?.asset3dId ? assetById.get(compB.asset3dId) : null);
        const pointA = labToThree(anchorA.position);
        const pointB = labToThree(anchorB.position);
        const material = new THREE.LineBasicMaterial({
          color: relation.solved ? "#22c55e" : "#f97316",
          transparent: true,
          opacity: 0.92,
        });
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pointA, pointB]), material);
        relationGroup.add(line);
        addAnchorAxis(relationGroup, pointA, anchorA.direction, "#38bdf8");
        addAnchorAxis(relationGroup, pointB, anchorB.direction, "#f59e0b");
      }

      if (!relationDraftTarget) return;
      const objectA = objectById.get(relationDraftTarget.objectAId);
      const objectB = objectById.get(relationDraftTarget.objectBId);
      if (!objectA || !objectB) return;
      const draftCompA = componentById.get(objectA.componentId);
      const draftCompB = componentById.get(objectB.componentId);
      const anchorA = worldAnchor(objectA, draftCompA, relationDraftTarget.anchorAId, draftCompA?.asset3dId ? assetById.get(draftCompA.asset3dId) : null);
      const anchorB = worldAnchor(objectB, draftCompB, relationDraftTarget.anchorBId, draftCompB?.asset3dId ? assetById.get(draftCompB.asset3dId) : null);
      const pointA = labToThree(anchorA.position);
      const pointB = labToThree(anchorB.position);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([pointA, pointB]),
        new THREE.LineDashedMaterial({
          color: "#eab308",
          dashSize: 0.28,
          gapSize: 0.16,
          transparent: true,
          opacity: 0.95,
        }),
      );
      line.computeLineDistances();
      relationGroup.add(line);
      addAnchorAxis(relationGroup, pointA, anchorA.direction, "#38bdf8");
      addAnchorAxis(relationGroup, pointB, anchorB.direction, "#f59e0b");
    }

    if (SHOW_BEAM_PATHS) {
      for (const beamPath of sceneData.beamPaths) {
        if (!beamPath.visible) continue;
        const sourceState = beamPath.sourceComponentId
          ? stateByComponentId.get(beamPath.sourceComponentId)
          : undefined;
        const active = sourceState?.state.enabled !== false;
        beamGroup.add(createBeamPath(beamPath, active));
      }
    }

    void renderComponents();
    renderRelations();

    return () => {
      cancelled = true;
      clearGroup(componentGroup);
      clearGroup(beamGroup);
      clearGroup(relationGroup);
    };
  }, [sceneData, selectedComponentId, selectedObjectId, selectedRelationId, previewObjectTransforms, relationDraftTarget]);

  return <div ref={mountRef} className="viewer-canvas" />;
}
