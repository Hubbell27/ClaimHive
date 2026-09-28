import { redirect } from "next/navigation";
import { AuthForm, AuthShell } from "@/components/AuthForm";
import { mfaAction, mfaSetupData } from "@/lib/actions/auth";
import { currentSession } from "@/lib/auth/session";

export default async function MfaPage() {
  const s = await currentSession();
  if (!s) redirect("/login");
  const setup = await mfaSetupData();
  return (
    <AuthShell title={setup ? "Set up your authenticator app" : "Enter your 6-digit code"}>
      {setup && (
        <div className="mb-4 space-y-2 text-sm">
          <p>Scan this with Google Authenticator, Microsoft Authenticator or Authy, then enter the code it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="Authenticator QR code" className="mx-auto h-52 w-52 rounded border" />
          <p className="text-stone-500">Can&apos;t scan? Key: <code className="break-all">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code></p>
        </div>
      )}
      <AuthForm action={mfaAction} submit="Verify" fields={[
        { name: "code", label: "6-digit code", inputMode: "numeric", autoComplete: "one-time-code", autoFocus: true },
      ]} />
    </AuthShell>
  );
}
