import type { ComponentItem } from "../types/digitalTwin";

export function getComponentName(component: ComponentItem): string {
  return component.componentName ?? component.name;
}

export function isOpticalTableComponent(component: ComponentItem): boolean {
  return (
    component.componentType === "optical_table" ||
    getComponentName(component).toLowerCase().includes("optical_table")
  );
}
