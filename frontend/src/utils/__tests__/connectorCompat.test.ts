import { describe, it, expect } from "vitest";

import cases from "./connector_compat_cases.json";
import {
  evaluateConnectorMating,
  connectorDescriptorFromParams,
  type ConnectorDescriptor,
  type MateOptions,
} from "../connectorCompat";

interface Case {
  name: string;
  out: ConnectorDescriptor;
  in: ConnectorDescriptor;
  opts?: MateOptions;
  expected: { status: string; codes: string[] };
}

describe("connector compat — shared parity fixture", () => {
  for (const c of (cases as { cases: Case[] }).cases) {
    it(c.name, () => {
      const v = evaluateConnectorMating(c.out, c.in, c.opts ?? {});
      expect(v.status).toBe(c.expected.status);
      expect([...v.codes].sort()).toEqual([...c.expected.codes].sort());
    });
  }
});

describe("connectorDescriptorFromParams", () => {
  it("maps an RF connector asset's params", () => {
    const d = connectorDescriptorFromParams("rf_cable_connector", {
      family: "sma",
      gender: "male",
      tipMm: 15.5,
    });
    expect(d).toEqual({ domain: "rf", family: "sma", gender: "male" });
  });

  it("maps a fibre connector asset's params", () => {
    const d = connectorDescriptorFromParams("fiber_connector", {
      polish: "APC",
      fiberType: "polarization_maintaining",
      slowAxisKeyed: true,
    });
    expect(d).toEqual({
      domain: "optical",
      polish: "APC",
      fiberType: "polarization_maintaining",
      slowAxisKeyed: true,
    });
  });
});
