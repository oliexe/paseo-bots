import { buildFullInstructions } from "paseo-plugin-genui/shared/instructions";

export const BOT_GENUI_INSTRUCTIONS = buildFullInstructions(true)
  .replace("If a block has errors, you get one request to fix it after the turn. ", "If a block has errors, use its diagnostic to correct it in your next reply. ")
  .replace(
    "The render_ui tool is optional: it checks a spec before showing it, so use it when a spec loads files you have not checked; put the answer sentence in its answer field. ",
    "",
  );
