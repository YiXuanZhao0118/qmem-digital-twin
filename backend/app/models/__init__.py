"""Models package — themed split of the legacy single-file models.py.

Top-level re-exports preserve the historical ``from app.models import X``
import style so consumers (alembic env.py, routers, services, tests)
don't need to change. New code should prefer the themed submodule
import (``from app.models.hardware import Asset3D``) when adding a
new file in the same layer.
"""

from app.models.base import Base, JsonDict, JsonList  # noqa: F401
from app.models.agent import AgentSession, ApprovalEvent, SessionMutation  # noqa: F401
from app.models.hardware import Asset3D, Component, ComponentBinding  # noqa: F401
from app.models.interaction import AssemblyRelation, BeamPath, Connection, OpticalLink, RfLink  # noqa: F401
from app.models.modules.electronics import Circuit  # noqa: F401
from app.models.modules.em import EmProblem, Mesh  # noqa: F401
from app.models.modules.magnetics import Coil, MagneticsProblem  # noqa: F401
from app.models.modules.rf import RfChainNode  # noqa: F401
from app.models.physics import DeviceState, PhysicsElement  # noqa: F401
from app.models.scene import Collection, CollectionMember, CollectionTemplate, SceneObject, SceneView, SceneViewCollectionOverride  # noqa: F401
from app.models.settings import AppSetting  # noqa: F401
from app.models.simulation import BeamSegment, Revision, SimulationRun  # noqa: F401
from app.models.timing import TimingProgram  # noqa: F401

__all__ = [
    "Base",
    "JsonDict",
    "JsonList",
    "AgentSession",
    "AppSetting",
    "ApprovalEvent",
    "AssemblyRelation",
    "Asset3D",
    "BeamPath",
    "BeamSegment",
    "Circuit",
    "Coil",
    "Collection",
    "CollectionMember",
    "CollectionTemplate",
    "Component",
    "ComponentBinding",
    "Connection",
    "DeviceState",
    "EmProblem",
    "MagneticsProblem",
    "Mesh",
    "OpticalLink",
    "PhysicsElement",
    "Revision",
    "RfChainNode",
    "RfLink",
    "SceneObject",
    "SceneView",
    "SceneViewCollectionOverride",
    "SessionMutation",
    "SimulationRun",
    "TimingProgram",
]
