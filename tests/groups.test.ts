import { describe, expect, it } from "vitest";
import { promptSections, type BotGroup } from "../shared/bot";
import { groupBots, saveTeam, teamOf, teamPrompt, withoutBot } from "../shared/groups";
import { makeBot } from "./helpers";

const NOW = "2026-09-27T00:00:00.000Z";
const team = (patch: Partial<BotGroup> = {}): BotGroup => ({ id: "t1", name: "Ops", leadId: "chief", memberIds: ["chief", "scout", "inbox"], instructions: "", createdAt: NOW, updatedAt: NOW, ...patch });
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
    const moved = saveTeam([team(), other], null, { name: "New", leadId: "scout", memberIds: ["scout", "solo"], instructions: "" }, "t3", NOW);
    expect(moved.map((group) => [group.id, group.leadId, group.memberIds])).toEqual([
      ["t1", "chief", ["chief", "inbox"]],
      ["t2", null, []],
      ["t3", "scout", ["scout", "solo"]],
    ]);
    expect(saveTeam([team()], "t1", { name: "Ops", leadId: "ghost", memberIds: ["chief"], instructions: "" }, "x", NOW)[0]!.leadId).toBeNull();
    expect(withoutBot([team()], "chief", NOW)[0]).toMatchObject({ leadId: null, memberIds: ["scout", "inbox"] });
  });
});
