"use client";
import { useActionState } from "react";
import { approveLetterAction, saveLetterAction } from "@/lib/actions/appeals";

const ATT = [["xray", "X-ray"], ["narrative", "Narrative"], ["perio_chart", "Periodontal chart"], ["photo", "Photo"]] as const;

export function LetterEditor({ letterId, body, recipient, enclosures, version, approved, missing }: {
  letterId: string; body: string; recipient: string; enclosures: string[]; version: number; approved: boolean; missing: string[];
}) {
  const [saveState, save, saving] = useActionState(saveLetterAction, undefined);
  const [approveState, approve, approving] = useActionState(approveLetterAction, undefined);
  return (
    <div className="space-y-3">
      <form action={save} className="card space-y-3">
        <input type="hidden" name="letterId" value={letterId} />
        <label className="block"><span className="label">Insurer&apos;s appeals address</span>
          <textarea name="recipient" rows={3} defaultValue={recipient} className="field font-mono text-sm" placeholder={"Appeals Department\nPO Box 1234\nCity, ST 12345"} />
        </label>
        <label className="block"><span className="label">Letter</span>
          <textarea name="body" rows={18} defaultValue={body} className="field font-serif text-[15px] leading-relaxed" />
        </label>
        <fieldset>
          <legend className="label">Enclosures</legend>
          <div className="flex flex-wrap gap-4">
            {ATT.map(([v, l]) => (
              <label key={v} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="enclosures" value={v} defaultChecked={enclosures.includes(v)} className="h-4 w-4" />{l}
              </label>
            ))}
          </div>
        </fieldset>
        {missing.length > 0 && <p className="text-sm font-medium text-amber-800">Still to fill in: {missing.join(", ")}</p>}
        {saveState?.error && <p role="alert" className="text-sm font-medium text-money-lost">{saveState.error}</p>}
        {saveState?.saved && <p role="status" className="text-sm text-green-800">Saved as version {version}.{approved ? "" : " Approve it when it's ready."}</p>}
        <button type="submit" className="btn-secondary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
      </form>
      {!approved && (
        <form action={approve} className="card space-y-2 border-brand/40">
          <input type="hidden" name="letterId" value={letterId} />
          <input type="hidden" name="version" value={version} />
          <p className="text-sm">By approving, you confirm you&apos;ve read this letter (version {version}) and it&apos;s accurate. Only an approved letter can be downloaded or marked as sent.</p>
          {approveState?.error && <p role="alert" className="text-sm font-medium text-money-lost">{approveState.error}</p>}
          <button type="submit" className="btn-primary" disabled={approving}>{approving ? "Approving…" : `Approve version ${version}`}</button>
        </form>
      )}
    </div>
  );
}
