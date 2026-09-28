import { describe, expect, it } from "vitest";
import { promptSections, type BotGroup } from "../shared/bot";
import { groupBots, OTHER_BOTS_TAB, saveTeam, tabOf, teamLogoOf, teamOf, teamPrompt, teamTabs, withoutBot } from "../shared/groups";
import { LOGO_SIZE, motifLogo, MOTIF_NAMES, teamLogo } from "../shared/team-logo";
import { makeBot } from "./helpers";

const NOW = "2026-09-27T00:00:00.000Z";
const team = (patch: Partial<BotGroup> = {}): BotGroup => ({ id: "t1", name: "Ops", logo: null, leadId: "chief", memberIds: ["chief", "scout", "inbox"], instructions: "", createdAt: NOW, updatedAt: NOW, ...patch });
const bots = [makeBot({ id: "chief", name: "Chief", title: "Runs the house" }), makeBot({ id: "scout", name: "Scout", title: "Researcher" }), makeBot({ id: "inbox", name: "Inbox", archived: true }), makeBot({ id: "solo", name: "Solo" })];

describe("teams", () => {
  it("finds a bot's team and its live members", () => {
    expect(teamOf("scout", [team()])?.id).toBe("t1");
    expect(teamOf("solo", [team()])).toBeNull();
    const { lead, members } = groupBots(team(), bots);
    expect(lead?.name).toBe("Chief");
    expect(members.map((bot) => bot.name)).toEqual(["Scout"]);
  });

  it("tells the lead to coordinate and members who leads", () => {
    const withInstructions = team({ instructions: "Keep account numbers out of replies." });
    const chief = teamPrompt(withInstructions, bots[0]!, bots);
    expect(chief).toMatch(/^You are the Chief of Staff of the "Ops" team and the user's main contact for it\./);
    expect(chief).toContain("Teammates:\n- Scout: Researcher");
    expect(chief).toContain("Shared instructions for the team. The user manages them for every bot on the team; you can't edit them.\nKeep account numbers out of replies.");
    const scout = teamPrompt(withInstructions, bots[1]!, bots);
    expect(scout).toMatch(/^You're on the "Ops" team\. Chief leads it\./);
    expect(scout).toContain("- Chief (Chief of Staff): Runs the house");
    expect(promptSections(bots[1]!, { memory: "", memoryPath: null, recentWork: [], playbooks: [], team: scout, skills: [], paseoTools: false, botTools: false, apps: [] }).map((section) => section.title)).toEqual(["Persona", "Team"]);
  });

  it("keeps a bot on one team and drops leads that aren't members", () => {
    const other = team({ id: "t2", name: "Home", leadId: "solo", memberIds: ["solo"] });
    const moved = saveTeam([team(), other], null, { name: "New", logo: null, leadId: "scout", memberIds: ["scout", "solo"], instructions: "" }, "t3", NOW);
    expect(moved.map((group) => [group.id, group.leadId, group.memberIds])).toEqual([
      ["t1", "chief", ["chief", "inbox"]],
      ["t2", null, []],
      ["t3", "scout", ["scout", "solo"]],
    ]);
    expect(saveTeam([team()], "t1", { name: "Ops", logo: null, leadId: "ghost", memberIds: ["chief"], instructions: "" }, "x", NOW)[0]!.leadId).toBeNull();
    expect(withoutBot([team()], "chief", NOW)[0]).toMatchObject({ leadId: null, memberIds: ["scout", "inbox"] });
  });
});

describe("team tabs", () => {
  it("has none without teams", () => {
    expect(teamTabs([], bots)).toEqual([]);
  });

  it("gives each team a tab, lead first, then the bots without a team", () => {
    const listed = bots.filter((bot) => !bot.archived);
    const tabs = teamTabs([team({ memberIds: ["scout", "chief"] })], listed);
    expect(tabs.map((tab) => [tab.id, tab.bots.map((bot) => bot.id)])).toEqual([
      ["t1", ["chief", "scout"]],
      [OTHER_BOTS_TAB, ["solo"]],
    ]);
    expect(tabOf("scout", [team()])).toBe("t1");
    expect(tabOf("solo", [team()])).toBe(OTHER_BOTS_TAB);
  });

  it("leaves out Other bots when every bot is on a team", () => {
    expect(teamTabs([team({ memberIds: ["chief", "scout", "inbox", "solo"] })], bots).map((tab) => tab.id)).toEqual(["t1"]);
  });
});

describe("team logos", () => {
  it("draws older teams from their id", () => {
    expect(teamLogoOf(team())).toEqual({ seed: "t1", palette: null, imageUrl: null });
    const logo = { seed: "abc", palette: 2, imageUrl: null };
    expect(teamLogoOf(team({ logo }))).toBe(logo);
  });

  it("is deterministic and follows the pinned colour", () => {
    expect(teamLogo("abc")).toEqual(teamLogo("abc"));
    expect(teamLogo("abc", 3).motif).toBe(teamLogo("abc", 7).motif);
    expect(teamLogo("abc", 3).background).not.toBe(teamLogo("abc", 7).background);
    expect(teamLogo("abc", 3, { dark: true }).rows).toEqual(teamLogo("abc", 3).rows);
  });

  it("fits every motif in the grid with a free edge for the rounded tile", () => {
    for (const motif of MOTIF_NAMES) {
      const { rows } = motifLogo(motif, 0);
      expect(rows).toHaveLength(LOGO_SIZE);
      for (const runs of rows) expect(runs.reduce((width, run) => width + run.width, 0)).toBe(LOGO_SIZE);
      for (const y of [0, LOGO_SIZE - 1]) expect(rows[y]!.every((run) => run.color === null), `${motif} row ${y}`).toBe(true);
      for (const runs of rows) expect(runs[0]!.x === 0 && runs[0]!.color === null && runs[runs.length - 1]!.color === null, motif).toBe(true);
    }
  });
});
