import { describe, expect, it } from "vitest";

import {
  MESH_SKILL_IDS,
  MESH_SKILLS,
  MESH_SKILLS_VERSION,
  getMeshSkill,
  meshSkillCatalog,
  meshSkillsDocument,
} from "../src/mesh-skills.js";

describe("mesh skills", () => {
  it("stamps a version", () => {
    expect(MESH_SKILLS_VERSION).toBe("2026-07-25.4");
    expect(MESH_SKILLS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(meshSkillsDocument()).toContain(`Version: ${MESH_SKILLS_VERSION}`);
  });

  it("registers the four escalation tiers with unique ids", () => {
    const catalog = meshSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual([
      "mesh-do",
      "mesh-review",
      "mesh-waves",
      "mesh-swarm",
    ]);
    expect(new Set(catalog.map((skill) => skill.id)).size).toBe(catalog.length);
    expect(catalog.map((skill) => skill.tier).sort()).toEqual([1, 2, 3, 4]);
  });

  it("gives every skill a non-empty body stating tier, session, escalation, and stop rules", () => {
    for (const id of MESH_SKILL_IDS) {
      const skill = getMeshSkill(id);
      expect(skill.id).toBe(id);
      expect(skill.title.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.body.trim().length).toBeGreaterThan(0);
      expect(skill.body).toContain(`Tier ${skill.tier} · doctrine ${MESH_SKILLS_VERSION}`);
      expect(skill.body).toContain("## Session affinity");
      expect(skill.body).toContain("## Escalation");
      expect(skill.body).toContain("## Stopping condition");
      expect(skill.body).toContain("traffic_control_status");
      expect(skill.body).toContain("session");
      expect(skill.body).toContain(
        "## Friction-driven instruction improvement",
      );
      expect(skill.body).toContain("friction is recorded automatically");
      expect(skill.body).toContain("exact digest-bound out-of-band human approval");
      expect(skill.body).toContain(
        "never directly edit the rules they or another harness run under",
      );
      expect(meshSkillsDocument()).toContain(skill.body);
    }
  });

  it("escalates exactly one tier except at the top", () => {
    expect(getMeshSkill("mesh-do").body).toContain("exactly one tier, to `mesh-review`");
    expect(getMeshSkill("mesh-review").body).toContain("exactly one tier, to `mesh-waves`");
    expect(getMeshSkill("mesh-waves").body).toContain("exactly one tier, to `mesh-swarm`");
    expect(getMeshSkill("mesh-swarm").body).toContain("no tier above this one");
  });

  it("rejects an unknown skill id", () => {
    expect(() => getMeshSkill("mesh-nope")).toThrow("Unknown mesh skill: mesh-nope");
    expect(() => getMeshSkill("")).toThrow(/Unknown mesh skill/);
    expect(() => getMeshSkill("toString")).toThrow(/Unknown mesh skill/);
  });

  it("freezes the registry", () => {
    expect(Object.isFrozen(MESH_SKILLS)).toBe(true);
    expect(Object.isFrozen(MESH_SKILLS["mesh-do"])).toBe(true);
  });
});
