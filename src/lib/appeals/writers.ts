/**
 * Letter writers. Both take the de-identified AppealRequest and return the
 * letter body (salutation to closing) with {{PLACEHOLDERS}}. The letterhead,
 * date, insurer address, "Re:" block, signature and enclosure list are laid out
 * locally (pdf.ts), so no writer ever needs a real name or number.
 *
 * - templateWriter: ClaimHive's own wording. Used when no API key is set, in
 *   tests, and for practices whose data may not go to the API yet.
 * - anthropicWriter: the Anthropic API. The request is de-identified and checked
 *   by `assertNoIdentifiers` before this is called.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AppealRequest } from "./deidentify";

export interface WrittenLetter { body: string; writer: "ai" | "template"; model?: string }
export interface LetterWriter { name: "ai" | "template"; write(req: AppealRequest): Promise<WrittenLetter> }

export class WriterError extends Error {
  constructor(public readonly code: "refused" | "too_long" | "empty" | "api_error" | "rate_limited") { super(code); }
}

const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

export const templateWriter: LetterWriter = {
  name: "template",
  async write(r) {
    const procs = r.procedures.map((p) => `${p.code} (${p.description}${p.tooth ? `, tooth ${p.tooth}${p.surfaces ? ` ${p.surfaces}` : ""}` : ""})`);
    const reasons = [...new Set(r.procedures.flatMap((p) => p.denialReasons).concat(r.claimLevelReasons))];
    const denied = r.procedures.reduce((s, p) => s + Number(p.deniedDollars.slice(1)), 0);
    const paras: string[] = [];
    paras.push(`To the Appeals Department:`);
    paras.push(`On behalf of our patient, {{PATIENT_NAME}}, we ask you to reconsider the denial of ${list(procs)} provided on {{SERVICE_DATE}} (claim {{CLAIM_NUMBER}}). The claim was denied on {{DENIAL_DATE}}${reasons.length ? ` with reason ${list(reasons)}` : ""}, for a total of $${denied.toFixed(2)}.`);
    if (r.enclosures.length) {
      paras.push(`We have enclosed the ${list(r.enclosures)} that support${r.enclosures.length === 1 ? "s" : ""} this treatment. ${r.argument === "The documentation the insurer needs is now enclosed" || !r.argument ? "With this documentation, the claim meets the plan's requirements for payment." : ""}`.trim());
    }
    if (r.argument && r.argument !== "Other" && r.argument !== "The documentation the insurer needs is now enclosed") {
      paras.push(`${r.argument}. The treatment was clinically indicated, performed as documented, and billed with the correct procedure code${procs.length > 1 ? "s" : ""}.`);
    }
    if (r.notes) paras.push(r.notes);
    paras.push(`Please reprocess the claim and issue payment under the patient's benefits. If you need anything further, please contact our office.`);
    paras.push(`Sincerely,`);
    return { body: paras.join("\n\n"), writer: "template" };
  },
};

// Static, so the prompt cache can reuse it across letters.
const SYSTEM = `You write dental insurance appeal letters for a dental practice's billing staff. A biller will read, edit and approve every letter before it is used.

You receive a de-identified description of a denied claim. It never contains the patient's or practice's details. Wherever the letter needs one of those details, write the placeholder exactly as listed in "placeholders" (for example {{PATIENT_NAME}} or {{SERVICE_DATE}}). Don't invent names, dates, ID numbers, addresses, phone numbers or clinical facts that aren't in the input, and don't use any placeholder that isn't listed.

Write only the body of the letter: begin with the salutation ("To the Appeals Department:") and end with "Sincerely," on its own line. The letterhead, date, insurer address, reference block, signature and list of enclosures are added separately, so leave them out.

Keep it to about 150-300 words in plain, professional English. Say which procedures are being appealed and why they were denied, name the enclosed documents, and make the argument given. Where "evidence" is provided, you may note that the enclosed documentation addresses the reason for denial, but don't quote ClaimHive's statistics in the letter. Ask the insurer to reprocess the claim. Output plain text paragraphs separated by blank lines, with no markdown.`;

export function anthropicWriter(client: Pick<Anthropic, "beta"> = new Anthropic(), model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5"): LetterWriter {
  return {
    name: "ai",
    async write(r) {
      let res;
      try {
        res = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          output_config: { effort: "medium" },
          // On a safety decline, the API retries on Anthropic's recommended fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM,
          messages: [{ role: "user", content: `Write the appeal letter body for this denied claim:\n\n${JSON.stringify(r, null, 2)}` }],
        });
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) throw new WriterError("rate_limited");
        if (e instanceof Anthropic.APIError) throw new WriterError("api_error");
        throw e;
      }
      if (res.stop_reason === "refusal") throw new WriterError("refused");
      if (res.stop_reason === "max_tokens") throw new WriterError("too_long");
      const body = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      if (!body) throw new WriterError("empty");
      return { body, writer: "ai", model: res.model };
    },
  };
}
