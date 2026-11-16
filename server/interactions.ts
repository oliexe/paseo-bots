import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BOT_LABEL } from "../shared/bot";
import {
  INTERACTION_CARD, INTERACTION_DATA_BYTES, InteractionIdSchema, InteractionSchema, InteractionSpecSchema,
  interactionGetRpc, interactionReplyText, interactionRespondRpc, interactionRestoreRpc, responseSignature,
  validateInteractionResponse, type Interaction, type InteractionResponse, type InteractionSpec,
} from "../shared/interaction";
import { pluginDataPath } from "./bot-home";
import type { BotsHost } from "./host";
import type { PaseoApi } from "./paseo";
import { ensureRealDirectory, readRegularText } from "./files";

/** Durable card state is separate from the timeline, which is a projection that can be republished. */
export class InteractionStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: () => string = () => join(pluginDataPath(), "interactions")) {}

  private path(id: string): string { return join(this.directory(), `${InteractionIdSchema.parse(id)}.json`); }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory(), { recursive: true, mode: 0o700 });
    await ensureRealDirectory(this.directory());
  }

  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(key, next);
    void next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); }).catch(() => {});
    return next;
  }

  private async read(id: string): Promise<Interaction | null> {
    await this.ensureDirectory();
    const text = await readRegularText(this.path(id), INTERACTION_DATA_BYTES);
    if (text === null) return null;
    const card = InteractionSchema.parse(JSON.parse(text));
    if (card.id !== id) throw new Error("The stored card has a different id.");
    return card;
  }

  private async write(card: Interaction): Promise<void> {
    InteractionSchema.parse(card);
    const target = this.path(card.id);
    const temporary = `${target}.${randomBytes(6).toString("hex")}.write`;
    await this.ensureDirectory();
    try {
      await writeFile(temporary, JSON.stringify(card), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  /** A damaged record must not prevent unrelated chats from presenting new cards. */
  private async records(): Promise<Interaction[]> {
    await this.ensureDirectory();
    let names: string[];
    try { names = (await readdir(this.directory())).filter((name) => /^i-[a-f0-9]{24}\.json$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return []; }
    const records: Interaction[] = [];
    // Bound open file descriptors as retention can contain thousands of cards.
    for (let index = 0; index < names.length; index += 16) {
      const batch = await Promise.all(names.slice(index, index + 16).map(async (name) => {
        try { return await this.read(name.slice(0, -5)); }
        catch (error) {
          // Leave the file in place. Direct access fails closed; an idempotent
          // create cannot overwrite a record the owner may need to recover.
          console.error(`paseo-bots: could not read interactive card ${name}`, error);
          return null;
        }
      }));
      records.push(...batch.filter((card): card is Interaction => !!card));
    }
    return records;
  }

  /** Deleted bots cannot receive a response; do not let their pending cards exhaust retention. */
  async pruneDeletedBots(botIds: ReadonlySet<string>): Promise<void> {
    await this.exclusive(`create:${this.directory()}`, async () => {
      const records = await this.records();
      await Promise.all(records.filter((card) => !botIds.has(card.botId)).map((card) =>
        this.exclusive(this.path(card.id), async () => { await rm(this.path(card.id), { force: true }); }),
      ));
    });
  }

  private async publish(card: Interaction, paseo: PaseoApi): Promise<void> {
    await paseo.agents.ref(card.agentId).timeline.append({ type: "plugin", id: card.id, ...INTERACTION_CARD, data: { ...card } });
  }

  /** A failed projection must never make a successfully delivered answer look unsent. */
  private async publishQuietly(card: Interaction, paseo: PaseoApi): Promise<void> {
    await this.publish(card, paseo).catch((error: unknown) => console.error("paseo-bots: could not update an interactive card", error));
  }

  async create(input: { botId: string; agentId: string; spec: InteractionSpec; key?: string }, paseo: PaseoApi): Promise<Interaction> {
    const spec = InteractionSpecSchema.parse(input.spec);
    const id = `i-${input.key ? createHash("sha256").update(`${input.agentId}\0${input.key}`).digest("hex").slice(0, 24) : randomBytes(12).toString("hex")}`;
    return this.exclusive(`create:${this.directory()}`, () => this.exclusive(this.path(id), async () => {
      const existing = await this.read(id);
      if (existing) {
        if (existing.agentId !== input.agentId || existing.botId !== input.botId || JSON.stringify(existing.spec) !== JSON.stringify(spec)) throw new Error("This card key is already used for a different card. Choose another key.");
        await this.publish(existing, paseo);
        return existing;
      }
      const records = await this.records();
      const active = records.filter((card): card is Interaction => !!card && (card.status === "pending" || card.status === "submitting"));
      if (active.filter((card) => card.agentId === input.agentId).length >= 20) throw new Error("This chat already has 20 unanswered cards. Wait for the user to answer or dismiss them.");
      if (active.length >= 2000) throw new Error("There are too many unanswered cards. Dismiss old cards before creating more.");
      const card: Interaction = { id, botId: input.botId, agentId: input.agentId, spec, status: "pending", response: null, createdAt: new Date().toISOString(), resolvedAt: null, error: null };
      await this.write(card);
      try { await this.publish(card, paseo); }
      catch (error) { await rm(this.path(id), { force: true }); throw error; }
      // Keep pending cards and the latest 500 answered cards. Old timeline snapshots still show their outcome.
      const settled = records.filter((entry): entry is Interaction => !!entry && (entry.status === "answered" || entry.status === "dismissed")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      await Promise.all(settled.slice(500).map((entry) => rm(this.path(entry.id), { force: true }).catch(() => {})));
      return card;
    }));
  }

  async get(id: string, agentId: string): Promise<Interaction | null> {
    const card = await this.read(id);
    if (card && card.agentId !== agentId) throw new Error("This card belongs to another chat.");
    return card;
  }

  /** Provider reopen/replacement can discard native rows. Restore from durable state without delivering an answer. */
  async restore(agentId: string, host: BotsHost, id?: string): Promise<number> {
    return this.exclusive(`restore:${agentId}`, async () => {
      const paseo = host.requirePaseo();
      const snapshot = await paseo.agents.ref(agentId).refresh();
      const botId = snapshot?.agent.labels?.[BOT_LABEL];
      if (!botId || !(await host.bot(botId))) return 0;
      const records = id ? [await this.get(id, agentId)].filter((card): card is Interaction => !!card) : await this.records();
      const candidates = records.filter((card) => card.agentId === agentId && card.botId === botId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (!candidates.length) return 0;
      // Re-appending an unchanged item emits another timeline update. Check the
      // projection first so recovery is idempotent, including after replacement.
      const wanted = new Set(candidates.map((card) => card.id));
      const projected = new Map<string, string>();
      const timeline = paseo.agents.ref(agentId).timeline;
      let page = await timeline.refetch({ direction: "tail", projection: "projected", limit: 200 });
      const cursors = new Set<string>();
      for (let pages = 0; ; pages++) {
        if (page.error) throw new Error(page.error);
        for (const { item } of page.entries) {
          if (item.type !== "plugin" || item.pluginId !== "paseo-bots" || item.kind !== INTERACTION_CARD.kind || item.version !== INTERACTION_CARD.version) continue;
          const parsed = InteractionSchema.safeParse(item.data);
          if (parsed.success && wanted.has(parsed.data.id)) projected.set(parsed.data.id, JSON.stringify(parsed.data));
        }
        if (!page.hasOlder || projected.size === wanted.size) break;
        const cursor = page.startCursor;
        const key = JSON.stringify(cursor);
        if (!cursor || cursors.has(key) || pages >= 99) throw new Error("Could not verify the saved card history. Reopen this chat to retry.");
        cursors.add(key);
        page = await timeline.refetch({ direction: "before", cursor, projection: "projected", limit: 200 });
        if (page.reset || page.staleCursor) throw new Error("The chat changed while restoring its cards. Retry the chat.");
      }
      let restored = 0;
      for (const candidate of candidates) {
        // Read under the same lock as respond, so recovery can never overwrite
        // a newly accepted answer with the earlier pending snapshot.
        await this.exclusive(this.path(candidate.id), async () => {
          const card = await this.get(candidate.id, agentId);
          if (!card || card.botId !== botId) return;
          if (projected.get(card.id) === JSON.stringify(card)) return;
          await this.publish(card, paseo);
          restored++;
        });
      }
      return restored;
    });
  }

  async respond(id: string, agentId: string, input: InteractionResponse | undefined, host: BotsHost): Promise<Interaction> {
    return this.exclusive(this.path(id), async () => {
      let card = await this.get(id, agentId);
      if (!card) throw new Error("This card is no longer available.");
      const response = input ? validateInteractionResponse(card.spec, input) : card.response;
      if (!response) throw new Error("Choose an answer before submitting this card.");
      if (card.response && responseSignature(card.response) !== responseSignature(response)) throw new Error("This card has already received a different answer.");
      if (card.status === "answered" || card.status === "dismissed") return card;

      const paseo = host.requirePaseo();
      const bot = await host.bot(card.botId);
      if (!bot || bot.archived) throw new Error("This bot is no longer available. You can still copy the card's content.");
      const agent = paseo.agents.ref(agentId);
      const snapshot = await agent.refresh();
      if (!snapshot || snapshot.agent.labels?.[BOT_LABEL] !== card.botId) throw new Error("The card's original chat is no longer available.");
      if (snapshot.agent.archivedAt) throw new Error("Restore this chat before answering its card.");

      // Persist before delivery. A failed request can have reached the daemon, so its answer is frozen.
      // Retrying sends the same message id and payload; Paseo deduplicates that client message id.
      card = { ...card, status: "submitting", response, error: null };
      await this.write(card);
      await this.publishQuietly(card, paseo);
      try {
        await agent.send(interactionReplyText(card, response), { messageId: `bots-card-${card.id}`, activeTurnBehavior: "steer" });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const message = error instanceof Error ? error.message : String(error);
        card = { ...card, error: code === "agent_request_outcome_unknown" || message.includes("agent_request_outcome_unknown")
          ? "Paseo received the response, but delivery could not be confirmed. Check this chat before taking further action. Retrying keeps the same answer and will not send a duplicate."
          : message.slice(0, 1000) || "The answer could not be delivered. Retry when the host reconnects." };
        await this.write(card);
        await this.publishQuietly(card, paseo);
        throw error;
      }
      card = { ...card, status: response.action === "dismiss" ? "dismissed" : "answered", resolvedAt: new Date().toISOString(), error: null };
      await this.write(card);
      await this.publishQuietly(card, paseo);
      return card;
    });
  }
}

export const interactions = new InteractionStore();

export function registerInteractions(server: PluginServerContext, host: BotsHost): () => void {
  server.handle(interactionGetRpc, async ({ id, agentId, restore }, context) => {
    if (restore) { host.attach(context.paseo); await interactions.restore(agentId, host, id); }
    return { interaction: await interactions.get(id, agentId) };
  });
  server.handle(interactionRestoreRpc, async ({ agentId }, context) => {
    host.attach(context.paseo);
    return { restored: await interactions.restore(agentId, host) };
  });
  server.handle(interactionRespondRpc, async ({ id, agentId, response }, context) => {
    host.attach(context.paseo);
    return { interaction: await interactions.respond(id, agentId, response, host) };
  });
  let stopped = false;
  // Native chat sessions resume without mounting Bots. Rebuild their card
  // projection around turns too; only the persisted answer is ever republished.
  const recover = async ({ agent }: { agent: { id: string } }, context: { paseo: PaseoApi }) => {
    host.attach(context.paseo);
    // send() may await this hook while respond owns the card lock. Recovery
    // must be detached from that send, or the two operations wait on each other.
    if (!stopped) void host.botIdOf(agent.id).then((botId) => botId && !stopped ? interactions.restore(agent.id, host) : undefined).catch((error: unknown) => console.error("paseo-bots: could not restore interactive cards", error));
  };
  server.addHook("agent.turn.before", recover);
  server.addHook("agent.turn.after", recover);
  let observedUpdate = false;
  // A settings update is authoritative only when it parsed successfully. Archived
  // bots remain in this set because restoring them also restores their pending cards.
  const prune = (state: Awaited<ReturnType<typeof host.settings.read>>) => {
    if (stopped || state.status !== "ready") return;
    void interactions.pruneDeletedBots(new Set(state.values.bots.map((bot) => bot.id)))
      .catch((error: unknown) => console.error("paseo-bots: could not prune deleted bots' interactive cards", error));
  };
  const unsubscribe = host.settings.subscribe((state) => { observedUpdate = true; prune(state); });
  void host.settings.read().then((state) => { if (!observedUpdate) prune(state); }).catch((error: unknown) => console.error("paseo-bots: could not read bots for card retention", error));
  return () => { stopped = true; unsubscribe(); };
}
