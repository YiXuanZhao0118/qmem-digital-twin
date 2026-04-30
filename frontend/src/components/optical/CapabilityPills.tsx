import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem, PhysicsCapability } from "../../types/digitalTwin";

const CAPABILITY_OPTIONS: { value: PhysicsCapability; label: string; color: string }[] = [
  { value: "stress", label: "Stress", color: "#a78bfa" },
  { value: "optical", label: "Optical", color: "#fbbf24" },
  { value: "rf", label: "RF", color: "#34d399" },
  { value: "em", label: "EM", color: "#60a5fa" },
  { value: "thermal", label: "Thermal", color: "#f87171" },
  { value: "fluid", label: "Fluid", color: "#22d3ee" },
  { value: "quantum", label: "Quantum", color: "#f472b6" },
];

type Props = {
  component: ComponentItem;
};

export function CapabilityPills({ component }: Props) {
  const setComponentCapabilities = useSceneStore((state) => state.setComponentCapabilities);
  const current = new Set<PhysicsCapability>(component.physicsCapabilities ?? []);

  const toggle = async (capability: PhysicsCapability) => {
    const next = new Set(current);
    if (next.has(capability)) next.delete(capability);
    else next.add(capability);
    try {
      await setComponentCapabilities(component.id, Array.from(next));
    } catch (error) {
      console.error("Failed to set capabilities", error);
    }
  };

  return (
    <div className="capability-pills">
      <span className="capability-label">Physics:</span>
      {CAPABILITY_OPTIONS.map((option) => {
        const enabled = current.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={`capability-pill ${enabled ? "enabled" : "disabled"}`}
            onClick={() => toggle(option.value)}
            style={enabled ? { borderColor: option.color, color: option.color } : undefined}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
