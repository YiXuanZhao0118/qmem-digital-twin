"""The scene slice the RF-cable / PPG flows read, and the lookups on it.

Ports of the read side the web flows stand on:

* binding-tree anchors — ``componentBindings.assetsInBindingTree`` /
  ``anchorsInBindingTree`` / ``primaryAsset`` /
  ``deriveCablePropsFromConnectorBindings``. The walk is the backend's own
  port of ``resolveBindingTree`` (``app.optical.align.anchor_poses``); like
  the TS these answer IDENTITY questions (which ports exist) and return
  anchors in their owning asset's frame;
* port POSES — ``rfCableAnchorResolver.rfPortPoses`` /
  ``resolveRfPortPose``: every port placed through its binding chain by
  ``anchor_poses.resolve_anchor_poses_lab`` (the pinned twin of
  ``anchorPose.resolveAnchorPosesLab``), which is how connect, resnap, align
  and the PPG mount place a port since 2026-09-22;
* port domains — ``rfLinkPorts.ts`` (``resolveRfLinkPortDomain``,
  ``kindParticipatesInRfLink``, ``rfLinkRoleAnchors``,
  ``connectorFamilyFromAnchor``), read from the kinds manifest
  (``backend/data/kinds.json``, exported from the same plugins). Not
  ``domainsAreCompatible``: the store runs it after the panel's stricter
  exact-domain gate, where it can never decide;
* the RF Link panel's port list and occupancy (``RfLinkPanel.tsx``
  ``rfLinkPortsOf`` / ``rfLinkFallbackPorts`` / ``occupiedPortKeys``) —
  what decides which ports a connect / PPG attach may name;
* ``ppgAttachment.ts`` (``ppgAttachmentOf`` / ``ppgAttachments`` /
  ``ppgsAttachedTo``).

Rows are duck-typed (ORM rows in the service, ``SimpleNamespace`` in the
parity tests); ids are compared as ``str``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from types import SimpleNamespace
from typing import Any

from app.kinds_manifest import load_manifest
from app.optical.align.anchor_poses import (
    AlignScene,
    AnchorPoseLab,
    resolve_anchor_poses_lab,
    resolve_binding_tree,
)
from app.optical.align.ts_compat import V, read_xyz
from app.optical.rf_cables.geometry import js_truthy
from app.optical.rf_resolve import _primary_asset_id

PPG_KIND = "programmable_pulse_generator"
RF_LINK_DOMAINS = ("rf", "ttl", "trigger", "rfout")


# ─── the scene slice ────────────────────────────────────────────────────────

@dataclass
class RfScene:
    """Everything the flows read, in ``GET /api/scene`` order.

    ``components`` excludes archived rows (as the scene snapshot does);
    ``bindings`` is every ComponentBinding in (component, sort_order,
    created_at) order; ``object_bindings`` every ObjectBinding (the
    per-instance deltas and asset swaps a port is posed through)."""

    objects: list[Any]
    components: list[Any]
    bindings: list[Any]
    assets: list[Any]
    physics_elements: list[Any]
    object_bindings: list[Any] = field(default_factory=list)
    object_by_id: dict[str, Any] = field(init=False)
    component_by_id: dict[str, Any] = field(init=False)
    asset_by_id: dict[str, Any] = field(init=False)
    pe_by_object: dict[str, Any] = field(init=False)
    align: AlignScene = field(init=False)

    def __post_init__(self) -> None:
        self.object_by_id = {str(o.id): o for o in self.objects}
        self.component_by_id = {str(c.id): c for c in self.components}
        self.asset_by_id = {str(a.id): a for a in self.assets}
        # TS `find` = first match; there is one PhysicsElement per object.
        self.pe_by_object = {}
        for pe in self.physics_elements:
            self.pe_by_object.setdefault(str(pe.object_id), pe)
        by_component: dict[str, list[Any]] = {}
        for b in self.bindings:
            by_component.setdefault(str(b.component_id), []).append(b)
        ob_by_object: dict[str, dict[Any, Any]] = {}
        for ob in self.object_bindings:
            ob_by_object.setdefault(str(ob.object_id), {})[ob.component_binding_id] = ob
        self.align = AlignScene(
            objects=self.object_by_id,
            components=self.component_by_id,
            bindings_by_component=by_component,
            object_bindings=ob_by_object,
            assets=self.asset_by_id,
        )

    def component_of(self, obj: Any) -> Any | None:
        return self.component_by_id.get(str(obj.component_id))

    def kind_of(self, object_id: str) -> str | None:
        pe = self.pe_by_object.get(object_id)
        return pe.element_kind if pe is not None else None


def props_of(row: Any) -> dict:
    p = getattr(row, "properties", None)
    return p if isinstance(p, dict) else {}


def anchor_name(anchor: dict) -> Any:
    """``anchor.name ?? anchor.id``."""
    name = anchor.get("name")
    return name if name is not None else anchor.get("id")


def primary_dir(anchor: dict) -> V | None:
    """``anchorObjectLocalPrimaryDir``: axisX, else the legacy
    directionBodyLocal."""
    axis = read_xyz(anchor.get("axisXBodyLocal"))
    return axis if axis is not None else read_xyz(anchor.get("directionBodyLocal"))


# ─── binding-tree lookups (componentBindings.ts) ───────────────────────────

def primary_asset(scene: RfScene, component: Any) -> Any | None:
    """``primaryAsset``: the single root asset binding, else the legacy
    ``component.asset_3d_id`` (``rf_resolve._primary_asset_id``)."""
    bindings = scene.align.bindings_by_component.get(str(component.id), [])
    asset_id = _primary_asset_id(component, bindings)
    return scene.asset_by_id.get(str(asset_id)) if asset_id else None


def assets_in_binding_tree(scene: RfScene, component: Any) -> list[Any]:
    """``assetsInBindingTree``: every asset in tree order, deduped, with the
    legacy column as the fallback for a binding-less Component."""
    out: list[Any] = []
    seen: set[str] = set()

    def visit(nodes: list) -> None:
        for node in nodes:
            if node.target_kind == "asset" and str(node.asset.id) not in seen:
                seen.add(str(node.asset.id))
                out.append(node.asset)
            visit(node.children)

    visit(resolve_binding_tree(scene.align, component, None))
    if not out and component.asset_3d_id:
        legacy = scene.asset_by_id.get(str(component.asset_3d_id))
        if legacy is not None:
            out.append(legacy)
    return out


def _anchors(asset: Any) -> list[dict]:
    return [a for a in (asset.anchors or []) if isinstance(a, dict)]


def anchors_in_binding_tree(scene: RfScene, component: Any) -> list[tuple[Any, dict]]:
    """``anchorsInBindingTree``: (asset, anchor) pairs deduped by
    ``id|name``, first occurrence winning."""
    out: list[tuple[Any, dict]] = []
    seen: set[str] = set()
    for asset in assets_in_binding_tree(scene, component):
        for a in _anchors(asset):
            key = f"{a.get('id')}|{anchor_name(a)}"
            if key in seen:
                continue
            seen.add(key)
            out.append((asset, a))
    return out


# ─── port poses, through the binding chain (rfCableAnchorResolver.ts) ──────

@dataclass(frozen=True)
class PortPose:
    """``RfPortPose`` minus the TS-only axisY: one anchor posed as an RF port
    in its owner's Component CAD frame — the SceneObject's body frame, what
    :func:`geometry.resolve_linked_rf_cable_endpoint` takes as
    ``target_anchor_*_body`` under the object's pose."""

    anchor_id: str
    anchor_name: str
    asset_id: str
    anchor: dict
    pos_cad: V
    # The primary direction through the chain; the CAD frame's +X when the
    # anchor declares none, zero (degenerate) when it declares a zero vector.
    dir_cad: V


def _port_pose_of(p: AnchorPoseLab) -> PortPose:
    if p.axis_x_cad is not None:
        d = p.axis_x_cad
    else:
        d = V(0.0, 0.0, 0.0) if primary_dir(p.anchor) is not None else V(1.0, 0.0, 0.0)
    return PortPose(
        anchor_id=p.anchor_id, anchor_name=p.anchor_name, asset_id=p.asset_id,
        anchor=p.anchor, pos_cad=p.pos_cad, dir_cad=d,
    )


# The instance a catalog-time question poses against (the PPG attach mounts a
# PPG before its object exists): no id, so no ObjectBinding applies.
_CATALOG_INSTANCE = SimpleNamespace(id="", x_mm=0.0, y_mm=0.0, z_mm=0.0, rx_deg=0.0, ry_deg=0.0, rz_deg=0.0)


def port_poses(scene: RfScene, component: Any, obj: Any | None) -> list[PortPose]:
    """``rfPortPoses``: every anchor of ``component``'s binding tree posed
    through its binding chain for the instance ``obj`` (``None`` = the
    catalog) — ``anchor_poses.resolve_anchor_poses_lab``: binding transforms
    (nested ones composed), the instance's ObjectBinding deltas and asset
    swaps, i.e. the chain the tracer places anchors with. Tree order, first
    ``id|name`` wins."""
    inst = obj if obj is not None else _CATALOG_INSTANCE
    return [_port_pose_of(p) for p in resolve_anchor_poses_lab(scene.align, component, inst)]


def find_port_pose(scene: RfScene, obj: Any, anchor_id: Any, name: Any) -> PortPose | None:
    """``resolveRfPortPose``: the port an RF link names (``anchorId`` and
    ``name ?? id``) on ``obj``, posed, or ``None`` — also when a per-instance
    asset swap took it away (the panel, which lists the CATALOG tree, may
    still offer it)."""
    comp = scene.component_of(obj)
    if comp is None:
        return None
    for p in port_poses(scene, comp, obj):
        if p.anchor_id == anchor_id and p.anchor_name == name:
            return p
    return None


def _family_from_token(t: Any) -> str | None:
    if not isinstance(t, str):
        return None
    if t.startswith("sma"):
        return "sma"
    if t.startswith("bnc"):
        return "bnc"
    return None


def derive_cable_end_tokens(scene: RfScene, component: Any) -> dict | None:
    """``deriveCablePropsFromConnectorBindings`` (its rf_cable branch): the
    gendered connector token at end A / B, from the two connector-asset
    bindings ordered by ``properties.splineEnd`` then ``sortOrder``."""
    def is_connector(asset_id: Any) -> bool:
        a = scene.asset_by_id.get(str(asset_id)) if asset_id else None
        return a is not None and a.kind_id in ("fiber_connector", "rf_cable_connector")

    conn = [
        b for b in scene.bindings
        if str(b.component_id) == str(component.id) and b.target_kind == "asset" and is_connector(b.asset_3d_id)
    ]
    if len(conn) < 2:
        return None

    def end_rank(b: Any) -> int:
        e = props_of(b).get("splineEnd")
        return 0 if e == "A" else 1 if e == "B" else 2

    ordered = sorted(conn, key=lambda b: (end_rank(b), b.sort_order if b.sort_order is not None else 0))
    a_asset = scene.asset_by_id.get(str(ordered[0].asset_3d_id))
    b_asset = scene.asset_by_id.get(str(ordered[1].asset_3d_id))

    def tok(asset: Any) -> str:
        dp = asset.default_params if isinstance(asset.default_params, dict) else {}
        family = dp.get("family")
        gender = dp.get("gender")
        return f"{family if family is not None else 'sma'}_{gender if gender is not None else 'male'}"

    return {"endAConnector": tok(a_asset), "endBConnector": tok(b_asset)}


def cable_end_family(scene: RfScene, component: Any, end_key: str) -> str | None:
    """``createRfCableBetweenPorts.cableEndFamily``: the derived token, else
    the component's own ``properties[end]`` / ``connectorType``."""
    derived = derive_cable_end_tokens(scene, component)
    props = props_of(component)
    token = derived.get(end_key) if derived is not None else None
    if token is None:
        token = props.get(end_key)
    if token is None:
        token = props.get("connectorType")
    return _family_from_token(token)


def cable_end_connector_asset(scene: RfScene, cable_component_id: str, end: str) -> Any | None:
    """The asset bound at ``role == end_a / end_b`` (role only — the key the
    store's tip lookup uses, unlike the variant lookup above)."""
    role = "end_a" if end == "A" else "end_b"
    for b in scene.bindings:
        if str(b.component_id) == cable_component_id and b.role == role and b.target_kind == "asset":
            return scene.asset_by_id.get(str(b.asset_3d_id)) if b.asset_3d_id else None
    return None


# ─── port domains (rfLinkPorts.ts, from the manifest) ──────────────────────

@lru_cache(maxsize=1)
def _physics_by_kind() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for plugin in load_manifest().get("physics_plugins", []):
        physics = plugin.get("physics") or {}
        kind = physics.get("element_kind")
        if kind:
            out.setdefault(kind, physics)  # `pluginForKind` = first match
    return out


def _resolve_port_domain(physics: dict, anchor_id: str) -> str | None:
    """``kinds/_plugin.resolvePortDomain``."""
    explicit = (physics.get("port_domains") or {}).get(anchor_id)
    if explicit:
        return explicit
    if anchor_id in ("rf_in", "rf_out"):
        return "rf"
    if anchor_id.startswith("intercept_") or anchor_id.startswith("fiber_"):
        return "optical"
    if anchor_id in ("trigger_in", "trigger_out"):
        return "trigger"
    if anchor_id.startswith("ttl_") or anchor_id == "gate_in":
        return "ttl"
    return None


def resolve_rf_link_port_domain(kind: str | None, anchor_id: str) -> str | None:
    """``resolveRfLinkPortDomain``."""
    if not kind:
        return None
    if kind == PPG_KIND and anchor_id == "rf_out":
        return "rfout"
    physics = _physics_by_kind().get(kind)
    if physics is None:
        return None
    domain = _resolve_port_domain(physics, anchor_id)
    return domain if domain in RF_LINK_DOMAINS else None


def _declared_anchors(physics: dict) -> list[str]:
    anchors = physics.get("anchors") or {}
    return [*(anchors.get("required") or []), *(anchors.get("optional") or [])]


def kind_participates_in_rf_link(kind: str | None) -> bool:
    """``kindParticipatesInRfLink``."""
    if not kind:
        return False
    physics = _physics_by_kind().get(kind)
    if physics is None:
        return False
    return any(_resolve_port_domain(physics, a) in RF_LINK_DOMAINS for a in _declared_anchors(physics))


def rf_link_role_anchors(kind: str | None) -> list[tuple[str, str]]:
    """``rfLinkRoleAnchors``: ``(anchorId, domain)`` per declared RF role."""
    if not kind:
        return []
    physics = _physics_by_kind().get(kind)
    if physics is None:
        return []
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for anchor_id in _declared_anchors(physics):
        if anchor_id in seen:
            continue
        seen.add(anchor_id)
        domain = resolve_rf_link_port_domain(kind, anchor_id)
        if domain:
            out.append((anchor_id, domain))
    return out


def connector_family_from_anchor(anchor: dict | None) -> str | None:
    """``connectorFamilyFromAnchor`` (case-sensitive prefix, as the TS)."""
    ct = anchor.get("connectorType") if isinstance(anchor, dict) else None
    return _family_from_token(ct)


# ─── the RF Link panel's ports and occupancy ───────────────────────────────

@dataclass(frozen=True)
class PanelPort:
    """One port the RF Link panel offers (``RfLinkPanel.Port`` + owner)."""

    object_id: str
    anchor_id: str
    anchor_name: str
    role: str  # "in" | "out"
    domain: str
    connector_family: str | None

    @property
    def key(self) -> str:
        return f"{self.object_id}|{self.anchor_id}|{self.anchor_name}"


def port_role(anchor_id: str) -> str:
    return "in" if anchor_id in ("rf_in", "ttl_in", "trigger_in") else "out"


def panel_ports_of(scene: RfScene, object_id: str) -> list[PanelPort]:
    """``RfLinkPanel.nodes`` + ``rfLinkPortsOf`` + ``rfLinkFallbackPorts``:
    the ports the panel offers on one object (``[]`` when it is not an RF
    Link node). A mesh-less RF object gets its kind's role ports with no
    connector family — offered, but never connectable."""
    obj = scene.object_by_id.get(object_id)
    if obj is None:
        return []
    kind = scene.kind_of(object_id)
    if kind == "rf_cable" or not kind_participates_in_rf_link(kind):
        return []
    comp = scene.component_of(obj)
    anchors = [a for _, a in anchors_in_binding_tree(scene, comp)] if comp is not None else []
    ports: list[PanelPort] = []
    for a in anchors:
        aid = a.get("id")
        if not isinstance(aid, str):
            continue
        domain = resolve_rf_link_port_domain(kind, aid)
        if not domain:
            continue
        ports.append(PanelPort(
            object_id=object_id, anchor_id=aid, anchor_name=anchor_name(a), role=port_role(aid),
            domain=domain, connector_family=connector_family_from_anchor(a),
        ))
    if not ports:
        ports = [
            PanelPort(object_id=object_id, anchor_id=aid, anchor_name=aid, role=port_role(aid),
                      domain=domain, connector_family=None)
            for aid, domain in rf_link_role_anchors(kind)
        ]
    return ports


def _js_field(link: Any, key: str) -> str:
    """``${link.key}`` in a JS template literal, for a JSON value."""
    if not isinstance(link, dict) or key not in link:
        return "undefined"
    v = link[key]
    if v is None:
        return "null"
    if v is True or v is False:
        return "true" if v else "false"
    return str(v)


def ppg_attachment_of(obj: Any) -> dict | None:
    """``ppgAttachmentOf``: the record when all three fields are non-empty
    strings."""
    raw = props_of(obj).get("ppgAttachment")
    if not isinstance(raw, dict):
        return None
    keys = ("targetObjectId", "targetAnchorId", "targetAnchorName")
    if not all(isinstance(raw.get(k), str) and raw.get(k) for k in keys):
        return None
    return {k: raw[k] for k in keys}


def ppg_attachments(scene: RfScene) -> list[tuple[Any, dict]]:
    """``ppgAttachments``: (PPG object, attachment) in scene order."""
    ppg_ids = {str(pe.object_id) for pe in scene.physics_elements if pe.element_kind == PPG_KIND}
    out: list[tuple[Any, dict]] = []
    for obj in scene.objects:
        if str(obj.id) not in ppg_ids:
            continue
        att = ppg_attachment_of(obj)
        if att is not None:
            out.append((obj, att))
    return out


def occupied_port_keys(scene: RfScene) -> set[str]:
    """``RfLinkPanel.occupiedPortKeys``: every port an rf_cable end or a PPG
    attachment claims (``objectId|anchorId|anchorName``), plus each attached
    PPG's own ``rf_out``."""
    keys: set[str] = set()
    for obj in scene.objects:
        if scene.kind_of(str(obj.id)) != "rf_cable":
            continue
        eps = props_of(obj).get("rfCableEndpoints")
        for end in ("A", "B"):
            link = eps.get(end) if isinstance(eps, dict) else None
            if js_truthy(link):
                keys.add("|".join(_js_field(link, k) for k in ("targetObjectId", "targetAnchorId", "targetAnchorName")))
    for ppg, att in ppg_attachments(scene):
        keys.add(f"{att['targetObjectId']}|{att['targetAnchorId']}|{att['targetAnchorName']}")
        keys.add(f"{ppg.id}|rf_out|rf_out")
    return keys
