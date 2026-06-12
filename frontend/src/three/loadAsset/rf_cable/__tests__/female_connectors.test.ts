// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import * as THREE from "three";

import { buildBncFemaleConnectorGroup } from "../bnc_female_connector";
import { buildBncMaleConnectorGroup } from "../bnc_male_connector";
import { buildSmaFemaleConnectorGroup } from "../sma_female_connector";
import { buildSmaMaleConnectorGroup } from "../sma_male_connector";

const builders = {
  sma_male: buildSmaMaleConnectorGroup,
  sma_female: buildSmaFemaleConnectorGroup,
  bnc_male: buildBncMaleConnectorGroup,
  bnc_female: buildBncFemaleConnectorGroup,
};

describe("RF connector procedural builders", () => {
  for (const [name, build] of Object.entries(builders)) {
    it(`${name} returns a non-empty group extending along +X from x≈0`, () => {
      const g = build();
      expect(g).toBeInstanceOf(THREE.Group);
      expect(g.children.length).toBeGreaterThan(0);

      const box = new THREE.Box3().setFromObject(g);
      // Cable-end cap sits at x≈0 and the connector extends toward +X.
      expect(box.min.x).toBeGreaterThan(-0.05);
      expect(box.max.x).toBeGreaterThan(0);
    });
  }
});
